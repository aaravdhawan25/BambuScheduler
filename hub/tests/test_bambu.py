"""Pure parts of the real printer client (no network)."""

from __future__ import annotations

import ssl

from bambu_hub.bambu import (
    PUSHALL,
    ImplicitFTPS,
    _insecure_tls_context,
    build_project_file_command,
    merge_report,
    simple_command,
    snapshot_from_state,
)


def test_merge_report_accumulates_partial_updates() -> None:
    state: dict = {}
    merge_report(state, {"gcode_state": "RUNNING", "mc_percent": 10, "ams": {"tray_now": "0"}})
    merge_report(state, {"mc_percent": 11, "ams": {"ams_exist_bits": "1"}})
    assert state == {
        "gcode_state": "RUNNING",
        "mc_percent": 11,
        "ams": {"tray_now": "0", "ams_exist_bits": "1"},
    }


def test_snapshot_reads_fields() -> None:
    snap = snapshot_from_state(
        {
            "gcode_state": "running", "mc_percent": 42, "mc_remaining_time": 73,
            "nozzle_temper": 219.8, "bed_temper": "65.0", "subtask_name": "sched_ab12cd34_x.gcode.3mf",
            "print_error": 0,
        },
        connected=True,
    )
    assert snap.gcode_state == "RUNNING"
    assert snap.progress == 42 and snap.remaining_min == 73
    assert snap.nozzle == 219.8 and snap.bed == 65.0
    assert snap.subtask_name == "sched_ab12cd34_x.gcode.3mf"


def test_snapshot_offline_and_missing_fields() -> None:
    assert snapshot_from_state({"gcode_state": "IDLE"}, connected=False).connected is False
    snap = snapshot_from_state({}, connected=True)
    assert snap.connected and snap.gcode_state is None and snap.progress is None


def test_project_file_command_shape() -> None:
    cmd = build_project_file_command("sched_ab12cd34_part.gcode.3mf", True, [0, -1, 2])["print"]
    assert cmd["command"] == "project_file"
    assert cmd["param"] == "Metadata/plate_1.gcode"
    assert cmd["url"] == "file:///sdcard/sched_ab12cd34_part.gcode.3mf"
    assert cmd["subtask_name"] == "sched_ab12cd34_part.gcode.3mf"
    assert cmd["use_ams"] is True and cmd["ams_mapping"] == [0, -1, 2]
    assert cmd["bed_leveling"] is True and cmd["timelapse"] is False
    no_ams = build_project_file_command("x.gcode.3mf", False, [0, 1])["print"]
    assert no_ams["use_ams"] is False and no_ams["ams_mapping"] == []


def test_simple_commands() -> None:
    assert simple_command("pause") == {"print": {"command": "pause", "sequence_id": "0"}}
    assert PUSHALL == {"pushing": {"sequence_id": "0", "command": "pushall"}}


def test_tls_context_skips_verification_for_self_signed_cert() -> None:
    ctx = _insecure_tls_context()
    assert ctx.verify_mode == ssl.CERT_NONE and ctx.check_hostname is False
    ftp = ImplicitFTPS(ctx)
    assert ftp.sock is None
