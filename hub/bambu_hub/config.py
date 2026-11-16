"""Hub configuration from environment variables (loaded from hub/.env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


class ConfigError(Exception):
    pass


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_anon_key: str
    hub_email: str
    hub_password: str
    mock: bool
    printer_ip: str
    printer_serial: str
    printer_access_code: str
    loop_seconds: float
    work_dir: Path
    log_level: str
    mock_print_seconds: float
    ntfy_base_url: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        e = dict(os.environ if env is None else env)
        mock = _flag(e.get("MOCK"))
        missing = [
            k
            for k in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "HUB_EMAIL", "HUB_PASSWORD")
            if not e.get(k)
        ]
        if not mock:
            missing += [
                k
                for k in ("PRINTER_IP", "PRINTER_SERIAL", "PRINTER_ACCESS_CODE")
                if not e.get(k)
            ]
        if missing:
            raise ConfigError(f"Missing settings in hub/.env: {', '.join(missing)}")
        if "service_role" in e.get("SUPABASE_ANON_KEY", ""):
            raise ConfigError("SUPABASE_ANON_KEY looks like a service-role key. Use the anon key.")
        return cls(
            supabase_url=e["SUPABASE_URL"],
            supabase_anon_key=e["SUPABASE_ANON_KEY"],
            hub_email=e["HUB_EMAIL"],
            hub_password=e["HUB_PASSWORD"],
            mock=mock,
            printer_ip=e.get("PRINTER_IP", ""),
            printer_serial=e.get("PRINTER_SERIAL", ""),
            printer_access_code=e.get("PRINTER_ACCESS_CODE", ""),
            loop_seconds=float(e.get("LOOP_SECONDS", "4")),
            work_dir=Path(e.get("WORK_DIR", "/tmp/bambu-hub")),
            log_level=e.get("LOG_LEVEL", "INFO").upper(),
            mock_print_seconds=float(e.get("MOCK_PRINT_SECONDS", "120")),
            ntfy_base_url=e.get("NTFY_BASE_URL", "https://ntfy.sh"),
        )
