"""Real Bambu Lab A1 client over the LAN (LAN Only Mode + Developer Mode).

  * MQTT over TLS on 8883 (user `bblp`, password = access code, self-signed cert)
      subscribe device/<serial>/report, publish device/<serial>/request
  * FTPS with implicit TLS on 990 (same credentials) to put files on the SD card

Everything marked VERIFY is an assumption to confirm on real hardware; each
is isolated in one function/constant and listed in VERIFY.md.
"""

from __future__ import annotations

import ftplib
import json
import logging
import socket
import ssl
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

from .models import PrinterSnapshot
from .printer import STARTABLE_STATES, PrinterError

log = logging.getLogger(__name__)

MQTT_PORT = 8883
FTPS_PORT = 990
USERNAME = "bblp"
# If no report arrives for this long, ask for a full status dump.
PUSHALL_IF_SILENT_S = 60
# If no report arrives for this long, treat the printer as disconnected.
STALE_AFTER_S = 180
PUBLISH_TIMEOUT_S = 10


def _insecure_tls_context() -> ssl.SSLContext:
    """The printer uses a self-signed certificate; we can't verify it."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


# --------------------------------------------------------------------- MQTT


def merge_report(state: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """Reports are partial: deep-merge each one into the accumulated state."""
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(state.get(key), dict):
            merge_report(state[key], value)
        else:
            state[key] = value
    return state


def snapshot_from_state(state: dict[str, Any], connected: bool) -> PrinterSnapshot:
    if not connected:
        return PrinterSnapshot.offline()

    def _num(key: str) -> float | None:
        v = state.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    pct = _num("mc_percent")
    remaining = _num("mc_remaining_time")  # minutes
    err = state.get("print_error")
    return PrinterSnapshot(
        connected=True,
        gcode_state=(str(state["gcode_state"]).upper() if state.get("gcode_state") else None),
        progress=int(pct) if pct is not None else None,
        remaining_min=int(remaining) if remaining is not None else None,
        nozzle=_num("nozzle_temper"),
        bed=_num("bed_temper"),
        subtask_name=state.get("subtask_name") or None,
        print_error=int(err) if isinstance(err, (int, float)) else None,
    )


def build_project_file_command(
    remote_name: str, use_ams: bool, ams_mapping: list[int]
) -> dict[str, Any]:
    """The MQTT payload that starts a print of a .gcode.3mf on the SD card.

    VERIFY: exact field set accepted by A1 firmware, the `url` scheme
    (file:///sdcard/ vs ftp://), and that `ams_mapping` is indexed by slicer
    filament id - 1 with tray numbers 0-3 (and [] / -1 entries when unused).
    """
    return {
        "print": {
            "command": "project_file",
            "param": "Metadata/plate_1.gcode",
            "subtask_name": remote_name,
            "url": f"file:///sdcard/{remote_name}",
            "use_ams": bool(use_ams),
            "ams_mapping": list(ams_mapping) if use_ams else [],
            "bed_leveling": True,
            "vibration_cali": True,
            "flow_cali": False,
            "layer_inspect": False,
            "timelapse": False,
            "bed_type": "auto",
            "sequence_id": "0",
            "profile_id": "0",
            "project_id": "0",
            "subtask_id": "0",
            "task_id": "0",
        }
    }


def simple_command(command: str) -> dict[str, Any]:
    """pause / resume / stop."""
    return {"print": {"command": command, "sequence_id": "0"}}


PUSHALL = {"pushing": {"sequence_id": "0", "command": "pushall"}}


# --------------------------------------------------------------------- FTPS


class ImplicitFTPS(ftplib.FTP_TLS):
    """FTP over *implicit* TLS (TLS from the first byte, port 990).

    Python's FTP_TLS only does explicit TLS (AUTH TLS), so wrap the control
    socket as soon as it's created. Data connections must reuse the control
    connection's TLS session or the printer rejects them.
    """

    def __init__(self, context: ssl.SSLContext, timeout: float = 30) -> None:
        super().__init__(context=context, timeout=timeout)
        self._sock: socket.socket | None = None

    @property
    def sock(self) -> socket.socket | None:
        return self._sock

    @sock.setter
    def sock(self, value: socket.socket | None) -> None:
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value, server_hostname=self.host)
        self._sock = value

    def ntransfercmd(self, cmd: str, rest: int | str | None = None) -> tuple[socket.socket, int | None]:
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if getattr(self, "_prot_p", False):  # set by prot_p()
            assert isinstance(self.sock, ssl.SSLSocket)
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
        return conn, size

    def storbinary_no_unwrap(self, cmd: str, fp: Any, blocksize: int = 1 << 16) -> str:
        """Like storbinary, but skips the TLS unwrap() that hangs on Bambu printers.

        VERIFY: whether the A1 still needs this (it's a known issue on X1/P1).
        """
        self.voidcmd("TYPE I")
        with self.transfercmd(cmd) as conn:
            while buf := fp.read(blocksize):
                conn.sendall(buf)
        return self.voidresp()


# ------------------------------------------------------------------ client


class BambuPrinter:
    """Implements the `Printer` protocol against a real printer."""

    def __init__(self, ip: str, serial: str, access_code: str) -> None:
        self.ip = ip
        self.serial = serial
        self.access_code = access_code
        self._state: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._connected = False
        self._last_msg = 0.0
        self._last_pushall = 0.0
        self._started = False
        self._client = mqtt.Client(
            CallbackAPIVersion.VERSION2,
            client_id=f"bambu-hub-{uuid.uuid4().hex[:8]}",
            protocol=mqtt.MQTTv311,
        )
        self._client.username_pw_set(USERNAME, access_code)
        self._client.tls_set_context(_insecure_tls_context())
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

    @property
    def _report_topic(self) -> str:
        return f"device/{self.serial}/report"

    @property
    def _request_topic(self) -> str:
        return f"device/{self.serial}/request"

    # --- MQTT callbacks (paho network thread) ---

    def _on_connect(self, client: mqtt.Client, _ud: Any, _flags: Any, reason: Any, _props: Any) -> None:
        if getattr(reason, "is_failure", False):
            log.error("MQTT connect refused: %s (check the access code)", reason)
            return
        log.info("MQTT connected to %s", self.ip)
        self._connected = True
        client.subscribe(self._report_topic, qos=0)
        self._pushall()

    def _on_disconnect(self, _c: mqtt.Client, _ud: Any, _flags: Any, reason: Any, _props: Any) -> None:
        if self._connected:
            log.warning("MQTT disconnected: %s", reason)
        self._connected = False

    def _on_message(self, _c: mqtt.Client, _ud: Any, msg: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(msg.payload)
        except ValueError:
            return
        report = payload.get("print")
        if isinstance(report, dict):
            with self._lock:
                merge_report(self._state, report)
                self._last_msg = time.monotonic()

    # --- Printer protocol ---

    def ensure_connected(self) -> bool:
        if not self._started:
            log.info("Connecting to printer %s (MQTT %d)", self.ip, MQTT_PORT)
            self._client.connect_async(self.ip, MQTT_PORT, keepalive=30)
            self._client.loop_start()
            self._started = True
        if not self._connected:
            return False
        silent = time.monotonic() - self._last_msg
        if silent > PUSHALL_IF_SILENT_S and time.monotonic() - self._last_pushall > PUSHALL_IF_SILENT_S:
            self._pushall()
        return silent < STALE_AFTER_S

    def gcode_state(self) -> str | None:
        return self.snapshot().gcode_state

    def snapshot(self) -> PrinterSnapshot:
        fresh = self._connected and time.monotonic() - self._last_msg < STALE_AFTER_S
        with self._lock:
            return snapshot_from_state(dict(self._state), fresh)

    def upload_file(self, local_path: Path, remote_name: str) -> None:
        log.info("FTPS upload %s -> %s:/%s", local_path.name, self.ip, remote_name)
        ftp = ImplicitFTPS(_insecure_tls_context())
        try:
            ftp.connect(self.ip, FTPS_PORT)
            ftp.login(USERNAME, self.access_code)
            ftp.prot_p()
            with local_path.open("rb") as f:
                # VERIFY: the FTP root is the SD card root on the A1.
                ftp.storbinary_no_unwrap(f"STOR /{remote_name}", f)
        except (OSError, ftplib.Error, EOFError) as e:
            raise PrinterError(f"Upload to printer failed: {e}. Is an SD card inserted?") from e
        finally:
            try:
                ftp.quit()
            except Exception:
                ftp.close()

    def start_print(self, remote_name: str, use_ams: bool, ams_mapping: list[int]) -> None:
        state = self.gcode_state()
        if state not in STARTABLE_STATES:
            # Defence in depth: the scheduler checks too.
            raise PrinterError(f"Printer is {state}; refusing to start")
        self._publish(build_project_file_command(remote_name, use_ams, ams_mapping))

    def pause(self) -> None:
        self._publish(simple_command("pause"))

    def resume(self) -> None:
        self._publish(simple_command("resume"))

    def stop(self) -> None:
        self._publish(simple_command("stop"))

    def close(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()

    # --- internals ---

    def _pushall(self) -> None:
        self._last_pushall = time.monotonic()
        self._client.publish(self._request_topic, json.dumps(PUSHALL), qos=0)

    def _publish(self, payload: dict[str, Any]) -> None:
        if not self._connected:
            raise PrinterError("Printer is not connected")
        cmd = payload.get("print", {}).get("command", "?")
        log.info("MQTT -> %s", cmd)
        info = self._client.publish(self._request_topic, json.dumps(payload), qos=1)
        try:
            info.wait_for_publish(timeout=PUBLISH_TIMEOUT_S)
        except (ValueError, RuntimeError) as e:
            raise PrinterError(f"Sending {cmd} failed: {e}") from e
        if not info.is_published():
            raise PrinterError(f"Sending {cmd} to the printer timed out")
