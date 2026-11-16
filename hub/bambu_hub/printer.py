"""Printer interface, plus a MockPrinter for development and tests.

The real LAN client lives in `bambu.py` and implements the same Protocol.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Protocol

from .models import PrinterSnapshot, utcnow

log = logging.getLogger(__name__)

# VERIFY: states in which it's safe to send a new project_file command.
# After a stop/failed print the A1 may sit in FAILED until a new print starts;
# if so, add "FAILED" here after confirming on hardware.
STARTABLE_STATES = frozenset({"IDLE", "FINISH"})
# States in which the printer is busy with a print.
ACTIVE_STATES = frozenset({"PREPARE", "RUNNING", "PAUSE", "SLICING"})


class PrinterError(Exception):
    """A printer operation failed. The message is shown to the user."""


class Printer(Protocol):
    def ensure_connected(self) -> bool:
        """Connect if needed. Returns True when connected. Never raises."""

    def gcode_state(self) -> str | None:
        """Latest gcode_state (IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED) or None."""

    def snapshot(self) -> PrinterSnapshot:
        """Merged latest status."""

    def upload_file(self, local_path: Path, remote_name: str) -> None:
        """Copy a .gcode.3mf to the SD card root. Raises PrinterError."""

    def start_print(self, remote_name: str, use_ams: bool, ams_mapping: list[int]) -> None:
        """Start printing a file already on the SD card. Raises PrinterError."""

    def pause(self) -> None: ...

    def resume(self) -> None: ...

    def stop(self) -> None: ...

    def close(self) -> None: ...


@dataclass
class _MockRun:
    remote_name: str
    started: datetime
    paused_at: datetime | None = None
    paused_total: timedelta = timedelta(0)


class MockPrinter:
    """A pretend A1: PREPARE for `prepare_seconds`, RUNNING for `print_seconds`, then FINISH.

    Driven by an injectable clock so tests can fast-forward time. Knobs:
      connected      -- False simulates the printer being off / unreachable
      fail_upload    -- message to raise from upload_file
      fail_start     -- message to raise from start_print
      ignore_start   -- accept the start command but never begin printing
      initial_state / initial_subtask -- e.g. a leftover FINISH from a previous job
    """

    def __init__(
        self,
        clock: Callable[[], datetime] = utcnow,
        print_seconds: float = 60,
        prepare_seconds: float = 5,
        initial_state: str = "IDLE",
        initial_subtask: str = "",
    ) -> None:
        self.clock = clock
        self.print_seconds = print_seconds
        self.prepare_seconds = prepare_seconds
        self.connected = True
        self.fail_upload: str | None = None
        self.fail_start: str | None = None
        self.ignore_start = False
        self.files: dict[str, int] = {}
        self.commands: list[str] = []  # log of everything sent, for tests
        self._idle_state = initial_state
        self._subtask = initial_subtask
        self._run: _MockRun | None = None
        self._lock = threading.Lock()

    # --- Printer protocol -------------------------------------------------

    def ensure_connected(self) -> bool:
        return self.connected

    def gcode_state(self) -> str | None:
        return self.snapshot().gcode_state

    def snapshot(self) -> PrinterSnapshot:
        if not self.connected:
            return PrinterSnapshot.offline()
        with self._lock:
            return self._snapshot_locked()

    def upload_file(self, local_path: Path, remote_name: str) -> None:
        self._require_connected()
        if self.fail_upload:
            raise PrinterError(self.fail_upload)
        size = local_path.stat().st_size
        self.files[remote_name] = size
        self.commands.append(f"upload {remote_name}")
        log.info("[mock] uploaded %s (%d bytes)", remote_name, size)

    def start_print(self, remote_name: str, use_ams: bool, ams_mapping: list[int]) -> None:
        self._require_connected()
        state = self.gcode_state()
        if state not in STARTABLE_STATES:
            raise PrinterError(f"Printer is {state}; refusing to start")
        if remote_name not in self.files:
            raise PrinterError(f"{remote_name} is not on the SD card")
        if self.fail_start:
            raise PrinterError(self.fail_start)
        self.commands.append(f"start {remote_name} ams={use_ams} mapping={ams_mapping}")
        if self.ignore_start:
            return
        with self._lock:
            self._run = _MockRun(remote_name=remote_name, started=self.clock())
            self._subtask = remote_name

    def pause(self) -> None:
        self._require_connected()
        self.commands.append("pause")
        with self._lock:
            if self._run and self._run.paused_at is None and self._phase() == "RUNNING":
                self._run.paused_at = self.clock()

    def resume(self) -> None:
        self._require_connected()
        self.commands.append("resume")
        with self._lock:
            if self._run and self._run.paused_at is not None:
                self._run.paused_total += self.clock() - self._run.paused_at
                self._run.paused_at = None

    def stop(self) -> None:
        self._require_connected()
        self.commands.append("stop")
        with self._lock:
            if self._run and self._phase() in ACTIVE_STATES:
                self._run = None
                # VERIFY: the A1 reports FAILED after a user stop.
                self._idle_state = "FAILED"

    def close(self) -> None:
        pass

    # --- test helpers -----------------------------------------------------

    def cancel_at_printer(self) -> None:
        """Simulate someone cancelling on the printer's screen (goes back to IDLE)."""
        with self._lock:
            self._run = None
            self._idle_state = "IDLE"

    def fail_now(self, code: int = 0x0300_8001) -> None:
        with self._lock:
            self._run = None
            self._idle_state = "FAILED"

    # --- internals --------------------------------------------------------

    def _require_connected(self) -> None:
        if not self.connected:
            raise PrinterError("Printer is not connected")

    def _elapsed(self) -> float:
        assert self._run is not None
        end = self._run.paused_at or self.clock()
        return (end - self._run.started - self._run.paused_total).total_seconds()

    def _phase(self) -> str:
        if self._run is None:
            return self._idle_state
        if self._run.paused_at is not None:
            return "PAUSE"
        elapsed = self._elapsed()
        if elapsed < self.prepare_seconds:
            return "PREPARE"
        if elapsed < self.prepare_seconds + self.print_seconds:
            return "RUNNING"
        # Finished: settle into FINISH permanently.
        self._run = None
        self._idle_state = "FINISH"
        return "FINISH"

    def _snapshot_locked(self) -> PrinterSnapshot:
        run = self._run
        state = self._phase()
        progress: int | None = 0
        remaining: int | None = None
        if state in ("RUNNING", "PAUSE") and run is not None:
            printed = max(0.0, self._elapsed() - self.prepare_seconds)
            progress = min(99, int(100 * printed / self.print_seconds))
            remaining = max(0, round((self.print_seconds - printed) / 60))
        elif state == "PREPARE":
            remaining = round(self.print_seconds / 60)
        elif state == "FINISH":
            progress, remaining = 100, 0
        hot = state in ACTIVE_STATES
        return PrinterSnapshot(
            connected=True,
            gcode_state=state,
            progress=progress,
            remaining_min=remaining,
            nozzle=220.0 if hot else 28.0,
            bed=65.0 if hot else 26.0,
            subtask_name=self._subtask,
            print_error=0,
        )
