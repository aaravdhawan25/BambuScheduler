"""The hub's brain: job state machine, command handling and hub_status.

    pending -> uploading -> printing -> awaiting_clear -> done
                  |            |                ^
                  v            v                |  (plate_clear command)
              attention <------+----------------+
    pending -> missed      (owner: pending/attention -> cancelled)

All decisions are made from the database plus the printer's live state, so a
restarted hub picks up exactly where it left off. The only in-memory state is
"have we seen this job running", which is re-derived from the printer after a
restart (see `_advance_printing`).
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .models import (
    ATTENTION,
    AWAITING_CLEAR,
    DONE,
    MISSED,
    PENDING,
    PRINTING,
    UPLOADING,
    Command,
    Job,
    PrinterSnapshot,
    Settings,
    job_tag,
    remote_name_for,
)
from .notify import Notifier
from .printer import ACTIVE_STATES, STARTABLE_STATES, Printer
from .store import Store

log = logging.getLogger(__name__)

WAIT_PLATE = "Waiting for plate to be cleared"


@dataclass
class Timing:
    # A FINISH only counts if we saw RUNNING, or this long after starting with our file name.
    finish_trust_after: timedelta = timedelta(seconds=60)
    # If the printer hasn't started our print by then, a human should look.
    start_timeout: timedelta = timedelta(minutes=3)
    # Commands older than this when the hub sees them are not executed (safety).
    command_max_age: timedelta = timedelta(minutes=5)
    # Target 12 s so that, rounded up to the next 3-5 s tick, writes are never >15 s apart.
    heartbeat: timedelta = timedelta(seconds=12)
    cleanup_every: timedelta = timedelta(hours=1)
    file_retention: timedelta = timedelta(days=7)


class CommandRejected(Exception):
    pass


@dataclass
class _Memory:
    seen_active: set[str] = field(default_factory=set)  # PREPARE/RUNNING/PAUSE seen
    seen_running: set[str] = field(default_factory=set)  # RUNNING/PAUSE seen
    stop_requested: set[str] = field(default_factory=set)
    notified_waiting: set[str] = field(default_factory=set)


class Hub:
    def __init__(
        self,
        store: Store,
        printer: Printer,
        notifier: Notifier,
        work_dir: Path,
        clock: Callable[[], datetime],
        timing: Timing | None = None,
        version: str = __version__,
    ) -> None:
        self.store = store
        self.printer = printer
        self.notifier = notifier
        self.work_dir = work_dir
        self.clock = clock
        self.t = timing or Timing()
        self.version = version
        self.plate_clear = False
        self.last_error: str | None = None
        self.mem = _Memory()
        self.settings = Settings()
        self._last_status: dict[str, Any] | None = None
        self._last_status_at: datetime | None = None
        self._last_cleanup: datetime | None = None
        # Set when we sent the printer something this tick, so we re-read its state.
        self.printer_commands_sent = False

    # ------------------------------------------------------------------ boot

    def recover(self) -> None:
        """Called once at startup, before the first tick."""
        self.plate_clear = self.store.load_plate_clear()
        self.settings = self.store.load_settings()
        for job in self.store.jobs_in_stages((UPLOADING,)):
            # We were interrupted mid-upload/start. We can't know whether the
            # start command reached the printer, so a human has to look.
            self._attention(
                job,
                UPLOADING,
                "The hub restarted while sending this print. Check the printer, "
                "then confirm the plate is clear.",
            )
        log.info("Recovered: plate_clear=%s", self.plate_clear)

    # ------------------------------------------------------------------ loop

    def tick(self) -> None:
        now = self.clock()
        self.settings = self.store.load_settings()
        snap = self._snapshot()
        self._process_commands(snap, now)
        if self.printer_commands_sent:
            snap = self._snapshot()
            self.printer_commands_sent = False
        self._advance_printing(snap, now)
        waiting = self._maybe_start(snap, now)
        if self.printer_commands_sent:
            snap = self._snapshot()
            self.printer_commands_sent = False
        self._write_status(snap, waiting, now)
        self._cleanup(now)


    def _snapshot(self) -> PrinterSnapshot:
        try:
            if not self.printer.ensure_connected():
                return PrinterSnapshot.offline()
            return self.printer.snapshot()
        except Exception as e:  # printer layer must never kill the loop
            self.note_error(f"Printer: {e}")
            return PrinterSnapshot.offline()

    def note_error(self, message: str) -> None:
        stamp = self.clock().strftime("%Y-%m-%d %H:%M:%SZ")
        self.last_error = f"{stamp} {message}"[:1000]
        log.error(message)

    # -------------------------------------------------------------- commands

    def _process_commands(self, snap: PrinterSnapshot, now: datetime) -> None:
        for cmd in self.store.pending_commands():
            age = now - cmd.created_at
            if age > self.t.command_max_age:
                self._finish_command(
                    cmd,
                    "failed",
                    f"Not executed: the hub received it {int(age.total_seconds() // 60)} min late.",
                    now,
                )
                continue
            try:
                result = self._handle_command(cmd, snap)
                self._finish_command(cmd, "done", result, now)
            except CommandRejected as e:
                self._finish_command(cmd, "failed", str(e), now)
            except Exception as e:
                self.note_error(f"Command {cmd.action} failed: {e}")
                self._finish_command(cmd, "failed", f"Failed: {e}", now)

    def _finish_command(self, cmd: Command, status: str, result: str, now: datetime) -> None:
        log.info("Command #%s %s -> %s: %s", cmd.id, cmd.action, status, result)
        self.store.finish_command(cmd.id, status, result, now)

    def _handle_command(self, cmd: Command, snap: PrinterSnapshot) -> str:
        state = snap.gcode_state
        if cmd.action == "plate_clear":
            return self._plate_clear(snap)
        if not snap.connected:
            raise CommandRejected("The printer is not connected.")
        if cmd.action == "pause":
            if state not in ("RUNNING", "PREPARE"):
                raise CommandRejected(f"Nothing to pause (printer is {_human(state)}).")
            log.info("PRINTER <- pause")
            self.printer.pause()
            self.printer_commands_sent = True
            return "Paused."
        if cmd.action == "resume":
            if state != "PAUSE":
                raise CommandRejected(f"Nothing to resume (printer is {_human(state)}).")
            log.info("PRINTER <- resume")
            self.printer.resume()
            self.printer_commands_sent = True
            return "Resumed."
        if cmd.action == "stop":
            if state not in ACTIVE_STATES:
                raise CommandRejected(f"Nothing to stop (printer is {_human(state)}).")
            for job in self.store.jobs_in_stages((PRINTING,)):
                self.mem.stop_requested.add(job.id)
            log.info("PRINTER <- stop")
            self.printer.stop()
            self.printer_commands_sent = True
            return "Stopped."
        raise CommandRejected(f"Unknown command {cmd.action!r}.")

    def _plate_clear(self, snap: PrinterSnapshot) -> str:
        if snap.connected and snap.gcode_state in ACTIVE_STATES:
            raise CommandRejected("The printer is still printing; the plate can't be clear yet.")
        if self.store.jobs_in_stages((UPLOADING, PRINTING)):
            raise CommandRejected("A print is in progress; the plate can't be clear yet.")
        closed = 0
        for job in self.store.jobs_in_stages((AWAITING_CLEAR, ATTENTION)):
            if self.store.update_job(job.id, job.stage, stage=DONE) is not None:
                log.info("Job %s %s -> done (plate cleared)", job.id, job.stage)
                closed += 1
        self.plate_clear = True
        log.info("Plate marked clear")
        return "Plate marked clear." + (f" Closed {closed} job(s)." if closed else "")

    # -------------------------------------------------------------- printing

    def _advance_printing(self, snap: PrinterSnapshot, now: datetime) -> None:
        for job in self.store.jobs_in_stages((PRINTING,)):
            self._advance_one(job, snap, now)

    def _advance_one(self, job: Job, snap: PrinterSnapshot, now: datetime) -> None:
        if not snap.connected:
            return  # can't judge; wait for the printer to come back
        state = snap.gcode_state
        ours = bool(snap.subtask_name) and job_tag(job.id) in (snap.subtask_name or "")
        unknown_subtask = not snap.subtask_name
        age = now - (job.started_at or now)

        if state in ACTIVE_STATES and (ours or unknown_subtask):
            self.mem.seen_active.add(job.id)
            if state in ("RUNNING", "PAUSE"):
                self.mem.seen_running.add(job.id)
            return

        trusted = job.id in self.mem.seen_running or (age >= self.t.finish_trust_after and ours)

        if state == "FINISH":
            if trusted:
                self._finished(job)
            elif age > self.t.start_timeout:
                self._attention(
                    job, PRINTING,
                    "The printer reports a finished print, but not this one. It may never have started.",
                )
            # else: probably a leftover FINISH from the previous job; wait.
            return

        if state == "FAILED":
            fresh = job.id in self.mem.seen_active or (age >= self.t.finish_trust_after and ours)
            if fresh or age > self.t.start_timeout:
                if job.id in self.mem.stop_requested:
                    note = "Stopped from the app. Clear the plate before the next print."
                else:
                    code = f" (error {snap.print_error:#x})" if snap.print_error else ""
                    note = f"The printer reported a failed print{code}. Check the printer."
                self._attention(job, PRINTING, note)
            return

        if state == "IDLE" and job.id in self.mem.seen_active:
            note = (
                "Stopped from the app."
                if job.id in self.mem.stop_requested
                else "The print was cancelled on the printer."
            )
            self._attention(job, PRINTING, note + " Clear the plate before the next print.")
            return

        if job.id not in self.mem.seen_active and age > self.t.start_timeout:
            self._attention(
                job, PRINTING,
                f"The printer didn't start this print within "
                f"{int(self.t.start_timeout.total_seconds() // 60)} min (printer is {_human(state)}).",
            )

    def _finished(self, job: Job) -> None:
        if self.settings.auto_continue:
            # Owner opted in to trusting the plate is fine after every print.
            if self.store.update_job(job.id, PRINTING, stage=DONE) is None:
                return
            self.plate_clear = True
            log.info("Job %s printing -> done (auto-continue)", job.id)
            self._notify("Print finished", f"{job.name} finished. Auto-continue is on.", tags="white_check_mark")
        else:
            if self.store.update_job(job.id, PRINTING, stage=AWAITING_CLEAR, finished_at=self.clock()) is None:
                return
            self.plate_clear = False
            log.info("Job %s printing -> awaiting_clear", job.id)
            self._notify(
                "Print finished", f"{job.name} finished. Clear the plate and confirm it in the app.",
                tags="white_check_mark",
            )
        self._forget(job.id)

    def _attention(self, job: Job, from_stage: str, note: str) -> None:
        if self.store.update_job(job.id, from_stage, stage=ATTENTION, note=note) is None:
            return
        self.plate_clear = False
        log.warning("Job %s %s -> attention: %s", job.id, from_stage, note)
        self._notify("Print needs attention", f"{job.name}: {note}", priority="high", tags="warning")
        self._forget(job.id)

    def _forget(self, job_id: str) -> None:
        self.mem.seen_active.discard(job_id)
        self.mem.seen_running.discard(job_id)
        self.mem.stop_requested.discard(job_id)

    # -------------------------------------------------------------- starting

    def _blocker(self, snap: PrinterSnapshot) -> str | None:
        """Why the next due job can't start right now (None = it can)."""
        if self.store.jobs_in_stages((ATTENTION,)):
            return "A print needs attention"
        busy = self.store.jobs_in_stages((UPLOADING, PRINTING, AWAITING_CLEAR))
        if any(j.stage == AWAITING_CLEAR for j in busy):
            return WAIT_PLATE
        if busy:
            return "Another print is in progress"
        if not self.plate_clear:
            return WAIT_PLATE
        if not snap.connected:
            return "Printer is offline"
        if snap.gcode_state not in STARTABLE_STATES:
            return f"Printer is busy ({_human(snap.gcode_state)})"
        return None

    def _maybe_start(self, snap: PrinterSnapshot, now: datetime) -> str | None:
        due = self.store.due_pending_jobs(now)
        if not due:
            return None
        blocker = self._blocker(snap)
        max_late = timedelta(minutes=self.settings.max_late_min)
        startable: list[Job] = []
        for job in due:
            if now - job.run_at > max_late:
                why = f" ({blocker})" if blocker else ""
                note = f"Didn't start within {self.settings.max_late_min} min of its scheduled time{why}."
                if self.store.update_job(job.id, PENDING, stage=MISSED, note=note) is not None:
                    log.warning("Job %s pending -> missed%s", job.id, why)
                    self._notify("Print missed", f"{job.name}: {note}", tags="hourglass")
                    self.mem.notified_waiting.discard(job.id)
            else:
                startable.append(job)
        if not startable:
            return None
        job = startable[0]
        if blocker:
            if blocker == WAIT_PLATE and job.id not in self.mem.notified_waiting:
                self.mem.notified_waiting.add(job.id)
                self._notify(
                    "Waiting for plate", f"{job.name} is due but the plate hasn't been cleared.",
                    tags="hourglass",
                )
            return blocker
        self._start(job, now)
        return None

    def _start(self, job: Job, now: datetime) -> None:
        claimed = self.store.update_job(job.id, PENDING, stage=UPLOADING)
        if claimed is None:
            log.info("Job %s was taken or changed before we could claim it", job.id)
            return
        log.info("Job %s pending -> uploading (%s)", job.id, job.name)
        self.mem.notified_waiting.discard(job.id)
        # Starting consumes the clear plate, before anything touches the printer.
        self.plate_clear = False
        self._write_status(self._snapshot(), None, now, force=True)

        remote = remote_name_for(job.id, job.name)
        local = self.work_dir / remote
        try:
            if self.store.update_job(job.id, UPLOADING, remote_name=remote) is None:
                raise RuntimeError("job changed while starting")
            log.info("Downloading %s", job.storage_path)
            self.store.download_file(job.storage_path, local)
            log.info("PRINTER <- upload %s", remote)
            self.printer.upload_file(local, remote)
            state = self.printer.gcode_state()
            if state not in STARTABLE_STATES:
                raise RuntimeError(f"printer became {_human(state)} before start")
            log.info("PRINTER <- start %s ams=%s mapping=%s", remote, job.use_ams, job.ams_mapping)
            self.printer.start_print(remote, job.use_ams, job.ams_mapping)
            self.printer_commands_sent = True
        except Exception as e:
            self.note_error(f"Starting {job.name}: {e}")
            self._attention(job, UPLOADING, f"Couldn't start the print: {e}")
            return
        finally:
            local.unlink(missing_ok=True)

        if self.store.update_job(job.id, UPLOADING, stage=PRINTING, started_at=self.clock()) is None:
            # Start was sent; job row is in an unexpected state. Leave it for a human.
            self.note_error(f"Job {job.id} started but its row changed unexpectedly")
            return
        log.info("Job %s uploading -> printing", job.id)

    # ----------------------------------------------------------- hub_status

    def _status_fields(self, snap: PrinterSnapshot, waiting: str | None) -> dict[str, Any]:
        active = self.store.jobs_in_stages((UPLOADING, PRINTING, AWAITING_CLEAR, ATTENTION))
        return {
            "hub_version": self.version,
            "last_error": self.last_error,
            "plate_clear": self.plate_clear,
            "waiting_reason": waiting,
            "active_job_id": active[0].id if active else None,
            "connected": snap.connected,
            "state": snap.gcode_state,
            "progress": snap.progress,
            "remaining_min": snap.remaining_min,
            "nozzle": snap.nozzle,
            "bed": snap.bed,
            "file": snap.subtask_name or None,
        }

    def _write_status(
        self, snap: PrinterSnapshot, waiting: str | None, now: datetime, force: bool = False
    ) -> None:
        fields = self._status_fields(snap, waiting)
        stale = self._last_status_at is None or now - self._last_status_at >= self.t.heartbeat
        if force or stale or fields != self._last_status:
            self.store.write_hub_status(fields)
            self._last_status = fields
            self._last_status_at = now

    # -------------------------------------------------------------- cleanup

    def _cleanup(self, now: datetime) -> None:
        if self._last_cleanup and now - self._last_cleanup < self.t.cleanup_every:
            return
        self._last_cleanup = now
        for job in self.store.purgeable_jobs(now - self.t.file_retention):
            try:
                self.store.delete_file(job.storage_path)
            except Exception as e:
                # A 404 means it's already gone; anything else, try next hour.
                if "404" not in str(e) and "not found" not in str(e).lower():
                    log.warning("Couldn't delete %s: %s", job.storage_path, e)
                    continue
            self.store.update_job(job.id, job.stage, file_purged_at=now)
            log.info("Deleted stored file for job %s", job.id)

    # ---------------------------------------------------------------- misc

    def _notify(self, title: str, message: str, priority: str = "default", tags: str = "") -> None:
        self.notifier.send(self.settings.ntfy_topic, title, message, priority, tags)


def _human(state: str | None) -> str:
    return (state or "unknown").lower()


def clear_work_dir(work_dir: Path) -> None:
    """Remove leftovers from a crash mid-download."""
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
