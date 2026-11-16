"""In-memory stand-ins for Supabase used by the scheduler tests.

FakeStore enforces the same hub transition rules as the SQL trigger, so a
scheduler bug that would be rejected by the real database fails here too.
"""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from bambu_hub.models import HUB_TRANSITIONS, TERMINAL_STAGES, Command, Job, Settings

T0 = datetime(2026, 11, 15, 20, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self, start: datetime = T0) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@dataclass
class FakeStore:
    clock: Clock
    jobs: dict[str, Job] = field(default_factory=dict)
    commands: dict[int, dict[str, Any]] = field(default_factory=dict)
    settings: Settings = field(default_factory=Settings)
    hub_status: dict[str, Any] = field(default_factory=lambda: {"plate_clear": False})
    status_writes: int = 0
    files: dict[str, bytes] = field(default_factory=dict)
    fail_download: str | None = None
    _next_cmd: int = 1

    # --- helpers for tests ------------------------------------------------

    def add_job(self, name: str = "Benchy.gcode.3mf", run_in_s: float = 0, **kw: Any) -> Job:
        jid = kw.pop("id", None) or str(uuid.uuid4())
        path = f"owner/{jid}/{name}"
        job = Job(
            id=jid,
            name=name,
            storage_path=path,
            run_at=self.clock.now + timedelta(seconds=run_in_s),
            stage=kw.pop("stage", "pending"),
            created_at=self.clock.now,
            **kw,
        )
        self.jobs[jid] = job
        self.files[path] = b"PK\x03\x04 fake 3mf"
        return job

    def add_command(self, action: str, age_s: float = 0) -> int:
        cid = self._next_cmd
        self._next_cmd += 1
        self.commands[cid] = {
            "id": cid,
            "action": action,
            "status": "pending",
            "created_at": self.clock.now - timedelta(seconds=age_s),
            "result": None,
        }
        return cid

    def stage(self, job_id: str) -> str:
        return self.jobs[job_id].stage

    # --- Store protocol ---------------------------------------------------

    def load_settings(self) -> Settings:
        return copy.copy(self.settings)

    def load_plate_clear(self) -> bool:
        return bool(self.hub_status.get("plate_clear"))

    def jobs_in_stages(self, stages: tuple[str, ...]) -> list[Job]:
        return sorted(
            (copy.copy(j) for j in self.jobs.values() if j.stage in stages),
            key=lambda j: j.run_at,
        )

    def due_pending_jobs(self, now: datetime) -> list[Job]:
        return [j for j in self.jobs_in_stages(("pending",)) if j.run_at <= now]

    def update_job(self, job_id: str, expect_stage: str, **fields: Any) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None or job.stage != expect_stage:
            return None
        allowed = {"stage", "note", "started_at", "finished_at", "remote_name", "file_purged_at"}
        bad = set(fields) - allowed
        assert not bad, f"hub may not change {bad}"
        new_stage = fields.get("stage", job.stage)
        if new_stage != job.stage:
            assert (job.stage, new_stage) in HUB_TRANSITIONS, f"illegal {job.stage}->{new_stage}"
        for k, v in fields.items():
            setattr(job, k, v)
        if job.stage in TERMINAL_STAGES and job.finished_at is None:
            job.finished_at = self.clock.now
        return copy.copy(job)

    def pending_commands(self) -> list[Command]:
        return [
            Command(id=c["id"], action=c["action"], created_at=c["created_at"])
            for c in sorted(self.commands.values(), key=lambda c: c["id"])
            if c["status"] == "pending"
        ]

    def finish_command(self, command_id: int, status: str, result: str, now: datetime) -> None:
        c = self.commands[command_id]
        assert c["status"] == "pending", "command handled twice"
        c.update(status=status, result=result, handled_at=now)

    def write_hub_status(self, fields: dict[str, Any]) -> None:
        self.hub_status.update(fields)
        self.hub_status["last_seen"] = self.clock.now
        self.status_writes += 1

    def download_file(self, storage_path: str, dest: Path) -> None:
        if self.fail_download:
            raise RuntimeError(self.fail_download)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.files[storage_path])

    def purgeable_jobs(self, finished_before: datetime) -> list[Job]:
        return [
            copy.copy(j)
            for j in self.jobs.values()
            if j.stage in TERMINAL_STAGES
            and j.finished_at is not None
            and j.finished_at < finished_before
            and j.file_purged_at is None
        ]

    def delete_file(self, storage_path: str) -> None:
        if storage_path not in self.files:
            raise RuntimeError("Supabase 404: Object not found")
        del self.files[storage_path]


class RecordingNotifier:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send(self, topic: str | None, title: str, message: str, priority: str = "default",
             tags: str = "") -> None:
        self.sent.append((title, message))

    def titles(self) -> list[str]:
        return [t for t, _ in self.sent]
