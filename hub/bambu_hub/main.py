"""Entry point: `python -m bambu_hub` (or the `bambu-hub` script).

Runs forever: every LOOP_SECONDS it reads commands/jobs from Supabase, talks
to the printer, and writes hub_status. Network trouble backs off and retries.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from pathlib import Path

from dotenv import load_dotenv

from . import __version__
from .config import Config, ConfigError
from .models import utcnow
from .notify import NtfyNotifier
from .printer import MockPrinter, Printer
from .scheduler import Hub, clear_work_dir
from .store import SupabaseStore
from .supa import SupabaseClient

log = logging.getLogger("bambu_hub")

MAX_BACKOFF_S = 60.0


def make_printer(cfg: Config) -> Printer:
    if cfg.mock:
        log.warning("MOCK=1: using a simulated printer, nothing will really print")
        return MockPrinter(print_seconds=cfg.mock_print_seconds)
    from .bambu import BambuPrinter  # imported lazily so MOCK mode needs no MQTT

    return BambuPrinter(cfg.printer_ip, cfg.printer_serial, cfg.printer_access_code)


def run(cfg: Config, stop: threading.Event) -> None:
    client = SupabaseClient(cfg.supabase_url, cfg.supabase_anon_key, cfg.hub_email, cfg.hub_password)
    store = SupabaseStore(client)
    printer = make_printer(cfg)
    clear_work_dir(cfg.work_dir)
    hub = Hub(store, printer, NtfyNotifier(cfg.ntfy_base_url), cfg.work_dir, clock=utcnow)

    backoff = cfg.loop_seconds
    recovered = False
    try:
        while not stop.is_set():
            try:
                if not recovered:
                    hub.recover()
                    recovered = True
                hub.tick()
                backoff = cfg.loop_seconds
            except Exception as e:  # network down, Supabase hiccup, bug...
                hub.note_error(f"{type(e).__name__}: {e}")
                log.debug("tick failed", exc_info=True)
                backoff = min(MAX_BACKOFF_S, backoff * 2)
                log.info("Retrying in %.0f s", backoff)
            stop.wait(backoff)
    finally:
        printer.close()
        client.close()
        log.info("Hub stopped")


def main() -> None:
    load_dotenv(Path.cwd() / ".env")
    try:
        cfg = Config.from_env()
    except ConfigError as e:
        print(f"Config error: {e}", file=sys.stderr)
        sys.exit(2)
    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    log.info("Bambu hub %s starting (mock=%s)", __version__, cfg.mock)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    run(cfg, stop)


if __name__ == "__main__":
    main()
