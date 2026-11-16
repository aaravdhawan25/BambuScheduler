"""State machine tests: hub + MockPrinter + in-memory store, on a fake clock."""

from __future__ import annotations

from pathlib import Path

import pytest

from bambu_hub.models import job_tag
from bambu_hub.printer import MockPrinter
from bambu_hub.scheduler import WAIT_PLATE, Hub

from .fakes import Clock, FakeStore, RecordingNotifier

PRINT_S = 600
PREP_S = 30


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def store(clock: Clock) -> FakeStore:
    s = FakeStore(clock=clock)
    s.hub_status["plate_clear"] = True
    return s


@pytest.fixture
def printer(clock: Clock) -> MockPrinter:
    return MockPrinter(clock=clock, print_seconds=PRINT_S, prepare_seconds=PREP_S)


@pytest.fixture
def notifier() -> RecordingNotifier:
    return RecordingNotifier()


def make_hub(store: FakeStore, printer: MockPrinter, clock: Clock, notifier: RecordingNotifier,
             tmp_path: Path) -> Hub:
    hub = Hub(store, printer, notifier, tmp_path, clock=clock)
    hub.recover()
    return hub


@pytest.fixture
def hub(store: FakeStore, printer: MockPrinter, clock: Clock, notifier: RecordingNotifier,
        tmp_path: Path) -> Hub:
    return make_hub(store, printer, clock, notifier, tmp_path)


def run(hub: Hub, clock: Clock, seconds: float, step: float = 4) -> None:
    t = 0.0
    while t < seconds:
        clock.advance(step)
        hub.tick()
        t += step


# --------------------------------------------------------------- happy path


def test_full_lifecycle(hub: Hub, store: FakeStore, printer: MockPrinter, clock: Clock,
                        notifier: RecordingNotifier) -> None:
    job = store.add_job("My Part.gcode.3mf")
    hub.tick()
    j = store.jobs[job.id]
    assert j.stage == "printing"
    assert j.remote_name == f"{job_tag(job.id)}_My_Part.gcode.3mf"
    assert j.started_at == clock.now
    assert store.hub_status["plate_clear"] is False
    assert any(c.startswith("start ") for c in printer.commands)

    run(hub, clock, PREP_S + PRINT_S / 2)
    assert store.hub_status["state"] == "RUNNING"
    assert 0 < store.hub_status["progress"] < 100
    assert store.stage(job.id) == "printing"

    run(hub, clock, PRINT_S)
    assert store.stage(job.id) == "awaiting_clear"
    assert store.jobs[job.id].finished_at is not None
    assert "Print finished" in notifier.titles()

    store.add_command("plate_clear")
    hub.tick()
    assert store.stage(job.id) == "done"
    assert store.hub_status["plate_clear"] is True


def test_future_job_waits_until_run_at(hub: Hub, store: FakeStore, clock: Clock) -> None:
    job = store.add_job(run_in_s=3600)
    run(hub, clock, 3500)
    assert store.stage(job.id) == "pending"
    run(hub, clock, 120)
    assert store.stage(job.id) == "printing"


def test_auto_continue_marks_done_and_keeps_going(hub: Hub, store: FakeStore,
                                                  clock: Clock) -> None:
    store.settings.auto_continue = True
    first = store.add_job("a.gcode.3mf")
    second = store.add_job("b.gcode.3mf", run_in_s=60)
    hub.tick()
    run(hub, clock, PREP_S + PRINT_S + 8)
    assert store.stage(first.id) == "done"
    assert store.stage(second.id) == "printing"


# ----------------------------------------------------------- safety gates


def test_never_starts_while_plate_not_clear(hub: Hub, store: FakeStore, printer: MockPrinter,
                                            clock: Clock, notifier: RecordingNotifier) -> None:
    hub.plate_clear = False
    job = store.add_job()
    run(hub, clock, 120)
    assert store.stage(job.id) == "pending"
    assert store.hub_status["waiting_reason"] == WAIT_PLATE
    assert not any(c.startswith("start") for c in printer.commands)
    assert notifier.titles().count("Waiting for plate") == 1  # once, not every tick

    store.add_command("plate_clear")
    hub.tick()  # command processed, then the job starts in the same tick
    assert store.stage(job.id) == "printing"
    assert store.hub_status["waiting_reason"] is None


def test_plate_starts_unclear_on_fresh_install(store: FakeStore, printer: MockPrinter,
                                               clock: Clock, notifier: RecordingNotifier,
                                               tmp_path: Path) -> None:
    store.hub_status["plate_clear"] = False
    hub = make_hub(store, printer, clock, notifier, tmp_path)
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "pending"


def test_second_job_waits_for_plate_after_first(hub: Hub, store: FakeStore, clock: Clock) -> None:
    a = store.add_job("a.gcode.3mf")
    b = store.add_job("b.gcode.3mf", run_in_s=10)
    hub.tick()
    run(hub, clock, PREP_S + PRINT_S + 60)
    assert store.stage(a.id) == "awaiting_clear"
    assert store.stage(b.id) == "pending"
    assert store.hub_status["waiting_reason"] == WAIT_PLATE


def test_does_not_start_when_printer_busy(hub: Hub, store: FakeStore, printer: MockPrinter,
                                          clock: Clock) -> None:
    printer._idle_state = "RUNNING"  # someone printing from the screen
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "pending"
    assert store.hub_status["waiting_reason"] == "Printer is busy (running)"


def test_does_not_start_when_printer_offline(hub: Hub, store: FakeStore, printer: MockPrinter) -> None:
    printer.connected = False
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "pending"
    assert store.hub_status["waiting_reason"] == "Printer is offline"
    assert store.hub_status["connected"] is False


def test_attention_job_blocks_queue(hub: Hub, store: FakeStore) -> None:
    store.add_job(stage="attention")
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "pending"
    assert store.hub_status["waiting_reason"] == "A print needs attention"


def test_missed_when_too_late(hub: Hub, store: FakeStore, clock: Clock) -> None:
    store.settings.max_late_min = 30
    hub.plate_clear = False
    job = store.add_job()
    run(hub, clock, 29 * 60, step=60)
    assert store.stage(job.id) == "pending"
    run(hub, clock, 2 * 60, step=60)
    assert store.stage(job.id) == "missed"
    assert "30 min" in (store.jobs[job.id].note or "")
    assert WAIT_PLATE in (store.jobs[job.id].note or "")


def test_overdue_job_after_hub_downtime_is_missed_not_started(
    store: FakeStore, printer: MockPrinter, clock: Clock, notifier: RecordingNotifier,
    tmp_path: Path,
) -> None:
    store.settings.max_late_min = 60
    job = store.add_job(run_in_s=-2 * 3600)
    hub = make_hub(store, printer, clock, notifier, tmp_path)
    hub.tick()
    assert store.stage(job.id) == "missed"
    assert not printer.commands


# ------------------------------------------------------ double-start safety


def test_claim_is_atomic_two_hubs_one_start(store: FakeStore, clock: Clock, tmp_path: Path) -> None:
    store.hub_status["plate_clear"] = True
    p1 = MockPrinter(clock=clock)
    p2 = MockPrinter(clock=clock)
    h1 = Hub(store, p1, RecordingNotifier(), tmp_path / "1", clock=clock)
    h2 = Hub(store, p2, RecordingNotifier(), tmp_path / "2", clock=clock)
    h1.recover()
    h2.recover()
    job = store.add_job()
    # Both hubs saw the same due job; the second's claim must find it no longer pending.
    due = store.due_pending_jobs(clock.now)
    h1._start(due[0], clock.now)
    h2._start(due[0], clock.now)
    starts = [c for c in p1.commands + p2.commands if c.startswith("start")]
    assert len(starts) == 1
    assert store.stage(job.id) == "printing"


def test_job_never_started_twice_across_ticks(hub: Hub, store: FakeStore, printer: MockPrinter,
                                              clock: Clock) -> None:
    store.add_job()
    hub.tick()
    run(hub, clock, 120)
    assert len([c for c in printer.commands if c.startswith("start")]) == 1


def test_owner_cancel_wins_race(hub: Hub, store: FakeStore, printer: MockPrinter) -> None:
    job = store.add_job()
    due = store.due_pending_jobs(store.clock.now)
    store.jobs[job.id].stage = "cancelled"  # owner cancelled between read and claim
    hub._start(due[0], store.clock.now)
    assert store.stage(job.id) == "cancelled"
    assert not printer.commands


# ------------------------------------------------------- stale FINISH etc.


def test_leftover_finish_from_previous_job_is_not_trusted(
    store: FakeStore, clock: Clock, notifier: RecordingNotifier, tmp_path: Path,
) -> None:
    printer = MockPrinter(clock=clock, print_seconds=PRINT_S, prepare_seconds=PREP_S,
                          initial_state="FINISH", initial_subtask="sched_deadbeef_old.gcode.3mf")
    hub = make_hub(store, printer, clock, notifier, tmp_path)
    job = store.add_job()
    printer.ignore_start = True  # printer accepts the command but is slow to react
    hub.tick()
    assert store.stage(job.id) == "printing"
    run(hub, clock, 100)
    assert store.stage(job.id) == "printing", "old FINISH must not finish the new job"
    run(hub, clock, 120)
    assert store.stage(job.id) == "attention"
    assert "not this one" in (store.jobs[job.id].note or "")


def test_finish_with_our_name_after_60s_is_trusted_without_seeing_running(
    hub: Hub, store: FakeStore, printer: MockPrinter, clock: Clock,
) -> None:
    job = store.add_job()
    hub.tick()
    # Pretend we missed every RUNNING report (e.g. MQTT gap) and only see FINISH.
    printer._run = None
    printer._idle_state = "FINISH"
    clock.advance(30)
    hub.tick()
    assert store.stage(job.id) == "printing"  # too early to trust
    clock.advance(40)
    hub.tick()
    assert store.stage(job.id) == "awaiting_clear"


def test_printer_never_starts(hub: Hub, store: FakeStore, printer: MockPrinter, clock: Clock) -> None:
    printer.ignore_start = True
    job = store.add_job()
    hub.tick()
    run(hub, clock, 170)
    assert store.stage(job.id) == "printing"
    run(hub, clock, 20)
    assert store.stage(job.id) == "attention"
    assert "didn't start" in (store.jobs[job.id].note or "")


def test_long_prepare_does_not_time_out(store: FakeStore, clock: Clock, notifier: RecordingNotifier,
                                        tmp_path: Path) -> None:
    store.hub_status["plate_clear"] = True
    printer = MockPrinter(clock=clock, print_seconds=PRINT_S, prepare_seconds=400)
    hub = make_hub(store, printer, clock, notifier, tmp_path)
    job = store.add_job()
    hub.tick()
    run(hub, clock, 300)
    assert store.stage(job.id) == "printing"


def test_failed_print_needs_attention(hub: Hub, store: FakeStore, printer: MockPrinter,
                                      clock: Clock, notifier: RecordingNotifier) -> None:
    job = store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 60)
    printer.fail_now()
    hub.tick()
    assert store.stage(job.id) == "attention"
    assert "failed" in (store.jobs[job.id].note or "")
    assert "Print needs attention" in notifier.titles()


def test_cancelled_at_printer_needs_attention(hub: Hub, store: FakeStore, printer: MockPrinter,
                                              clock: Clock) -> None:
    job = store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 60)
    printer.cancel_at_printer()
    hub.tick()
    assert store.stage(job.id) == "attention"
    assert "cancelled on the printer" in (store.jobs[job.id].note or "")


# ---------------------------------------------------------------- failures


def test_upload_failure_goes_to_attention(hub: Hub, store: FakeStore, printer: MockPrinter) -> None:
    printer.fail_upload = "FTPS connection refused"
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "attention"
    assert "FTPS connection refused" in (store.jobs[job.id].note or "")
    assert store.hub_status["plate_clear"] is False
    assert "FTPS connection refused" in (store.hub_status["last_error"] or "")


def test_download_failure_goes_to_attention(hub: Hub, store: FakeStore) -> None:
    store.fail_download = "Supabase 404: Object not found"
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "attention"


def test_start_failure_goes_to_attention(hub: Hub, store: FakeStore, printer: MockPrinter) -> None:
    printer.fail_start = "MQTT publish timed out"
    job = store.add_job()
    hub.tick()
    assert store.stage(job.id) == "attention"


def test_plate_clear_resolves_attention_and_next_job_runs(hub: Hub, store: FakeStore,
                                                          printer: MockPrinter, clock: Clock) -> None:
    printer.fail_upload = "boom"
    a = store.add_job("a.gcode.3mf")
    b = store.add_job("b.gcode.3mf", run_in_s=5)
    hub.tick()
    assert store.stage(a.id) == "attention"
    printer.fail_upload = None
    run(hub, clock, 20)
    assert store.stage(b.id) == "pending"
    store.add_command("plate_clear")
    hub.tick()
    assert store.stage(a.id) == "done"
    assert store.stage(b.id) == "printing"


# ---------------------------------------------------------------- restart


def test_restart_mid_upload_goes_to_attention(store: FakeStore, printer: MockPrinter, clock: Clock,
                                              notifier: RecordingNotifier, tmp_path: Path) -> None:
    job = store.add_job(stage="uploading")
    make_hub(store, printer, clock, notifier, tmp_path)
    assert store.stage(job.id) == "attention"
    assert "restarted" in (store.jobs[job.id].note or "")


def test_restart_while_printing_finishes_normally(store: FakeStore, printer: MockPrinter,
                                                  clock: Clock, notifier: RecordingNotifier,
                                                  tmp_path: Path) -> None:
    hub1 = make_hub(store, printer, clock, notifier, tmp_path)
    job = store.add_job()
    hub1.tick()
    run(hub1, clock, PREP_S + 120)
    # Hub process dies; a new one starts with no memory.
    hub2 = make_hub(store, printer, clock, notifier, tmp_path)
    assert store.stage(job.id) == "printing"
    run(hub2, clock, PRINT_S)
    assert store.stage(job.id) == "awaiting_clear"
    assert len([c for c in printer.commands if c.startswith("start")]) == 1


def test_restart_after_print_finished_while_hub_was_down(store: FakeStore, printer: MockPrinter,
                                                         clock: Clock, notifier: RecordingNotifier,
                                                         tmp_path: Path) -> None:
    hub1 = make_hub(store, printer, clock, notifier, tmp_path)
    job = store.add_job()
    hub1.tick()
    clock.advance(PREP_S + PRINT_S + 600)  # hub down for the rest of the print
    hub2 = make_hub(store, printer, clock, notifier, tmp_path)
    hub2.tick()
    assert store.stage(job.id) == "awaiting_clear"


def test_restart_keeps_plate_flag(store: FakeStore, printer: MockPrinter, clock: Clock,
                                  notifier: RecordingNotifier, tmp_path: Path) -> None:
    hub1 = make_hub(store, printer, clock, notifier, tmp_path)
    store.add_job()
    hub1.tick()
    hub2 = make_hub(store, printer, clock, notifier, tmp_path)
    assert hub2.plate_clear is False


def test_printer_offline_while_printing_waits(hub: Hub, store: FakeStore, printer: MockPrinter,
                                              clock: Clock) -> None:
    job = store.add_job()
    hub.tick()
    printer.connected = False
    run(hub, clock, 600)
    assert store.stage(job.id) == "printing"  # no false alarm while we can't see it
    printer.connected = True
    run(hub, clock, PRINT_S)
    assert store.stage(job.id) == "awaiting_clear"


# ---------------------------------------------------------------- commands


def test_pause_resume(hub: Hub, store: FakeStore, printer: MockPrinter, clock: Clock) -> None:
    store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 20)
    cid = store.add_command("pause")
    hub.tick()
    assert store.commands[cid]["status"] == "done"
    assert store.hub_status["state"] == "PAUSE"
    cid = store.add_command("resume")
    hub.tick()
    assert store.commands[cid]["status"] == "done"
    assert store.hub_status["state"] == "RUNNING"


def test_stop_from_app(hub: Hub, store: FakeStore, printer: MockPrinter, clock: Clock) -> None:
    job = store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 20)
    cid = store.add_command("stop")
    hub.tick()
    assert store.commands[cid]["status"] == "done"
    assert store.stage(job.id) == "attention"
    assert "Stopped from the app" in (store.jobs[job.id].note or "")


def test_commands_rejected_when_meaningless(hub: Hub, store: FakeStore) -> None:
    cid = store.add_command("resume")
    hub.tick()
    assert store.commands[cid]["status"] == "failed"
    assert "Nothing to resume" in store.commands[cid]["result"]


def test_old_commands_are_not_executed(hub: Hub, store: FakeStore, printer: MockPrinter,
                                       clock: Clock) -> None:
    store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 20)
    cid = store.add_command("stop", age_s=3600)
    hub.tick()
    assert store.commands[cid]["status"] == "failed"
    assert "late" in store.commands[cid]["result"]
    assert "stop" not in printer.commands


def test_plate_clear_rejected_while_printing(hub: Hub, store: FakeStore, clock: Clock) -> None:
    store.add_job()
    hub.tick()
    run(hub, clock, PREP_S + 20)
    cid = store.add_command("plate_clear")
    hub.tick()
    assert store.commands[cid]["status"] == "failed"
    assert store.hub_status["plate_clear"] is False


def test_command_with_printer_offline_fails_cleanly(hub: Hub, store: FakeStore,
                                                    printer: MockPrinter) -> None:
    printer.connected = False
    cid = store.add_command("pause")
    hub.tick()
    assert store.commands[cid]["status"] == "failed"
    assert "not connected" in store.commands[cid]["result"]


# --------------------------------------------------------- status/cleanup


def test_heartbeat_written_at_least_every_15s(hub: Hub, store: FakeStore, clock: Clock) -> None:
    stamps = []
    for step in (4, 5, 3):
        for _ in range(20):
            clock.advance(step)
            hub.tick()
            stamps.append(store.hub_status["last_seen"])
    gaps = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:]) if b != a]
    assert gaps and max(gaps) <= 15
    assert store.hub_status["hub_version"]


def test_status_not_rewritten_when_unchanged(hub: Hub, store: FakeStore, clock: Clock) -> None:
    hub.tick()
    writes = store.status_writes
    run(hub, clock, 8, step=4)
    assert store.status_writes == writes


def test_cleanup_deletes_old_files_only(hub: Hub, store: FakeStore, clock: Clock) -> None:
    old = store.add_job(stage="done", finished_at=clock.now)
    clock.advance(8 * 86400)
    fresh = store.add_job(stage="done", finished_at=clock.now)
    pending = store.add_job(run_in_s=86400)
    hub.tick()
    assert old.storage_path not in store.files
    assert store.jobs[old.id].file_purged_at is not None
    assert fresh.storage_path in store.files
    assert pending.storage_path in store.files


def test_remote_name_sanitized() -> None:
    from bambu_hub.models import remote_name_for

    jid = "0f3c2a1b-1111-2222-3333-444444444444"
    assert remote_name_for(jid, "Cable clip (v2) ü.gcode.3mf") == "sched_0f3c2a1b_Cable_clip_v2.gcode.3mf"
    assert remote_name_for(jid, "!!!.3mf") == "sched_0f3c2a1b_print.gcode.3mf"
    assert len(remote_name_for(jid, "x" * 300)) < 80
