"""SupabaseClient/SupabaseStore against a fake HTTP server (httpx.MockTransport)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from bambu_hub.config import Config, ConfigError
from bambu_hub.store import SupabaseStore
from bambu_hub.supa import SupabaseClient, SupabaseError


class FakeSupabase:
    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.token_n = 0
        self.reject_token: str | None = None  # access token to answer 401 for
        self.refresh_fails = False

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        path = req.url.path
        if path == "/auth/v1/token":
            grant = req.url.params["grant_type"]
            if grant == "refresh_token" and self.refresh_fails:
                return httpx.Response(400, json={"error_description": "Invalid Refresh Token"})
            if grant == "password":
                body = json.loads(req.content)
                if body["password"] != "pw":
                    return httpx.Response(400, json={"error_description": "Invalid login credentials"})
            self.token_n += 1
            return httpx.Response(200, json={
                "access_token": f"at{self.token_n}", "refresh_token": f"rt{self.token_n}",
                "expires_in": 3600,
            })
        auth = req.headers.get("authorization", "")
        if self.reject_token and auth == f"Bearer {self.reject_token}":
            return httpx.Response(401, json={"message": "JWT expired"})
        if path == "/rest/v1/jobs" and req.method == "PATCH":
            if req.url.params.get("stage") == "eq.pending":
                return httpx.Response(200, json=[{
                    "id": "j1", "name": "n", "storage_path": "p", "stage": "uploading",
                    "run_at": "2026-11-15T20:00:00+00:00",
                }])
            return httpx.Response(200, json=[])
        if path.startswith("/storage/v1/object/authenticated/prints/"):
            return httpx.Response(200, content=b"3mf-bytes")
        return httpx.Response(200, json=[])


@pytest.fixture
def fake() -> FakeSupabase:
    return FakeSupabase()


def client(fake: FakeSupabase, password: str = "pw") -> SupabaseClient:
    http = httpx.Client(transport=httpx.MockTransport(fake.handler))
    return SupabaseClient("https://x.supabase.co", "anon", "hub@example.com", password, http=http)


def test_signs_in_once_and_sends_both_headers(fake: FakeSupabase) -> None:
    c = client(fake)
    c.select("settings", {"id": "eq.1"})
    c.select("settings", {"id": "eq.1"})
    assert [r.url.path for r in fake.calls].count("/auth/v1/token") == 1
    last = fake.calls[-1]
    assert last.headers["apikey"] == "anon"
    assert last.headers["authorization"] == "Bearer at1"


def test_refreshes_on_401_and_retries(fake: FakeSupabase) -> None:
    c = client(fake)
    c.select("settings", {})
    fake.reject_token = "at1"
    c.select("settings", {})
    grants = [r.url.params.get("grant_type") for r in fake.calls if r.url.path == "/auth/v1/token"]
    assert grants == ["password", "refresh_token"]
    assert fake.calls[-1].headers["authorization"] == "Bearer at2"


def test_falls_back_to_password_when_refresh_rejected(fake: FakeSupabase) -> None:
    c = client(fake)
    c.select("settings", {})
    fake.reject_token = "at1"
    fake.refresh_fails = True
    c.select("settings", {})
    grants = [r.url.params.get("grant_type") for r in fake.calls if r.url.path == "/auth/v1/token"]
    assert grants == ["password", "refresh_token", "password"]


def test_bad_password_raises_readable_error(fake: FakeSupabase) -> None:
    with pytest.raises(SupabaseError, match="Invalid login credentials"):
        client(fake, password="wrong").select("settings", {})


def test_claim_is_conditional_on_stage(fake: FakeSupabase) -> None:
    store = SupabaseStore(client(fake))
    job = store.update_job("j1", "pending", stage="uploading")
    assert job is not None and job.stage == "uploading"
    req = fake.calls[-1]
    assert req.url.params["id"] == "eq.j1"
    assert req.url.params["stage"] == "eq.pending"
    assert req.headers["prefer"] == "return=representation"
    assert store.update_job("j1", "printing", stage="done") is None


def test_timestamps_sent_as_utc_z(fake: FakeSupabase) -> None:
    store = SupabaseStore(client(fake))
    store.due_pending_jobs(datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc))
    assert fake.calls[-1].url.params["run_at"] == "lte.2026-11-15T12:00:00.000000Z"


def test_download_streams_to_file(fake: FakeSupabase, tmp_path: Path) -> None:
    store = SupabaseStore(client(fake))
    dest = tmp_path / "a" / "x.gcode.3mf"
    store.download_file("uid/job/My File.gcode.3mf", dest)
    assert dest.read_bytes() == b"3mf-bytes"
    assert fake.calls[-1].url.raw_path.endswith(b"/uid/job/My%20File.gcode.3mf")


def test_config_requires_printer_unless_mock() -> None:
    base = {"SUPABASE_URL": "u", "SUPABASE_ANON_KEY": "k", "HUB_EMAIL": "e", "HUB_PASSWORD": "p"}
    with pytest.raises(ConfigError, match="PRINTER_IP"):
        Config.from_env(base)
    assert Config.from_env({**base, "MOCK": "1"}).mock is True
