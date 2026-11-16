"""Database access for the hub, behind a small Protocol so tests can use a fake."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from .models import Command, Job, Settings, TERMINAL_STAGES, format_ts
from .supa import SupabaseClient

BUCKET = "prints"


class Store(Protocol):
    def load_settings(self) -> Settings: ...

    def load_plate_clear(self) -> bool: ...

    def jobs_in_stages(self, stages: tuple[str, ...]) -> list[Job]: ...

    def due_pending_jobs(self, now: datetime) -> list[Job]: ...

    def update_job(self, job_id: str, expect_stage: str, **fields: Any) -> Job | None:
        """Conditional update: only applies if the job is still in `expect_stage`.

        Returns the updated job, or None if nothing matched (someone else moved
        it first). This is what makes claiming a job atomic.
        """

    def pending_commands(self) -> list[Command]: ...

    def finish_command(self, command_id: int, status: str, result: str, now: datetime) -> None: ...

    def write_hub_status(self, fields: dict[str, Any]) -> None: ...

    def download_file(self, storage_path: str, dest: Path) -> None: ...

    def purgeable_jobs(self, finished_before: datetime) -> list[Job]: ...

    def delete_file(self, storage_path: str) -> None: ...


def _encode(value: Any) -> Any:
    if isinstance(value, datetime):
        return format_ts(value)
    return value


class SupabaseStore:
    def __init__(self, client: SupabaseClient) -> None:
        self.client = client

    def load_settings(self) -> Settings:
        rows = self.client.select("settings", {"id": "eq.1", "select": "*"})
        return Settings.from_row(rows[0] if rows else None)

    def load_plate_clear(self) -> bool:
        rows = self.client.select("hub_status", {"id": "eq.1", "select": "plate_clear"})
        return bool(rows and rows[0].get("plate_clear"))

    def jobs_in_stages(self, stages: tuple[str, ...]) -> list[Job]:
        rows = self.client.select(
            "jobs",
            {"stage": f"in.({','.join(stages)})", "order": "run_at.asc", "select": "*"},
        )
        return [Job.from_row(r) for r in rows]

    def due_pending_jobs(self, now: datetime) -> list[Job]:
        rows = self.client.select(
            "jobs",
            {
                "stage": "eq.pending",
                "run_at": f"lte.{format_ts(now)}",
                "order": "run_at.asc,created_at.asc",
                "select": "*",
            },
        )
        return [Job.from_row(r) for r in rows]

    def update_job(self, job_id: str, expect_stage: str, **fields: Any) -> Job | None:
        rows = self.client.update(
            "jobs",
            {"id": f"eq.{job_id}", "stage": f"eq.{expect_stage}"},
            {k: _encode(v) for k, v in fields.items()},
        )
        return Job.from_row(rows[0]) if rows else None

    def pending_commands(self) -> list[Command]:
        rows = self.client.select(
            "commands", {"status": "eq.pending", "order": "created_at.asc", "select": "*"}
        )
        return [Command.from_row(r) for r in rows]

    def finish_command(self, command_id: int, status: str, result: str, now: datetime) -> None:
        self.client.update(
            "commands",
            {"id": f"eq.{command_id}", "status": "eq.pending"},
            {"status": status, "result": result[:2000], "handled_at": format_ts(now)},
        )

    def write_hub_status(self, fields: dict[str, Any]) -> None:
        self.client.upsert("hub_status", {"id": 1, **{k: _encode(v) for k, v in fields.items()}})

    def download_file(self, storage_path: str, dest: Path) -> None:
        self.client.download(BUCKET, storage_path, dest)

    def purgeable_jobs(self, finished_before: datetime) -> list[Job]:
        rows = self.client.select(
            "jobs",
            {
                "stage": f"in.({','.join(TERMINAL_STAGES)})",
                "finished_at": f"lt.{format_ts(finished_before)}",
                "file_purged_at": "is.null",
                "select": "*",
                "limit": "50",
            },
        )
        return [Job.from_row(r) for r in rows]

    def delete_file(self, storage_path: str) -> None:
        self.client.remove(BUCKET, storage_path)
