"""Plain data types shared by the store, printer and scheduler."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Job stages (mirrors the CHECK constraint in the migration).
PENDING = "pending"
UPLOADING = "uploading"
PRINTING = "printing"
AWAITING_CLEAR = "awaiting_clear"
ATTENTION = "attention"
DONE = "done"
CANCELLED = "cancelled"
MISSED = "missed"

TERMINAL_STAGES = (DONE, CANCELLED, MISSED)

# Stage changes the hub is allowed to make. Mirrors public.jobs_guard() in SQL.
HUB_TRANSITIONS: frozenset[tuple[str, str]] = frozenset(
    {
        (PENDING, UPLOADING),
        (PENDING, MISSED),
        (UPLOADING, PRINTING),
        (UPLOADING, ATTENTION),
        (PRINTING, AWAITING_CLEAR),
        (PRINTING, DONE),
        (PRINTING, ATTENTION),
        (AWAITING_CLEAR, DONE),
        (ATTENTION, DONE),
    }
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: Any) -> datetime | None:
    """Parse a PostgREST timestamptz string (or pass through a datetime)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    # Python < 3.11 can't parse every fractional-second length; 3.11 can.
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def format_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass
class Job:
    id: str
    name: str
    storage_path: str
    run_at: datetime
    stage: str
    use_ams: bool = False
    ams_mapping: list[int] = field(default_factory=list)
    note: str | None = None
    remote_name: str | None = None
    est_seconds: int | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    file_purged_at: datetime | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        run_at = parse_ts(row.get("run_at"))
        assert run_at is not None, "jobs.run_at is NOT NULL"
        return cls(
            id=str(row["id"]),
            name=str(row["name"]),
            storage_path=str(row["storage_path"]),
            run_at=run_at,
            stage=str(row["stage"]),
            use_ams=bool(row.get("use_ams") or False),
            ams_mapping=[int(x) for x in (row.get("ams_mapping") or [])],
            note=row.get("note"),
            remote_name=row.get("remote_name"),
            est_seconds=row.get("est_seconds"),
            created_at=parse_ts(row.get("created_at")),
            started_at=parse_ts(row.get("started_at")),
            finished_at=parse_ts(row.get("finished_at")),
            file_purged_at=parse_ts(row.get("file_purged_at")),
        )


@dataclass
class Command:
    id: int
    action: str  # pause | resume | stop | plate_clear
    created_at: datetime
    job_id: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Command:
        created = parse_ts(row.get("created_at"))
        assert created is not None
        return cls(
            id=int(row["id"]),
            action=str(row["action"]),
            created_at=created,
            job_id=row.get("job_id"),
        )


@dataclass
class Settings:
    max_late_min: int = 60
    auto_continue: bool = False
    ntfy_topic: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any] | None) -> Settings:
        if not row:
            return cls()
        return cls(
            max_late_min=int(row.get("max_late_min") or 60),
            auto_continue=bool(row.get("auto_continue")),
            ntfy_topic=row.get("ntfy_topic") or None,
        )


@dataclass
class PrinterSnapshot:
    """What the printer last told us. All fields optional except connected."""

    connected: bool
    gcode_state: str | None = None
    progress: int | None = None
    remaining_min: int | None = None
    nozzle: float | None = None
    bed: float | None = None
    subtask_name: str | None = None
    print_error: int | None = None

    @classmethod
    def offline(cls) -> PrinterSnapshot:
        return cls(connected=False)


_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")
_EXT = re.compile(r"(\.gcode)?\.3mf$", re.IGNORECASE)


def job_tag(job_id: str) -> str:
    """Short, unique-enough prefix used to recognise our file on the printer."""
    return f"sched_{job_id.replace('-', '')[:8]}"


def remote_name_for(job_id: str, name: str) -> str:
    """`sched_<job id short>_<sanitized name>.gcode.3mf` (FAT/SD-card safe)."""
    stem = _EXT.sub("", name.strip())
    stem = _UNSAFE.sub("_", stem).strip("_")[:40] or "print"
    return f"{job_tag(job_id)}_{stem}.gcode.3mf"
