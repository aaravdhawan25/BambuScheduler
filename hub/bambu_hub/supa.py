"""Tiny Supabase client (Auth + PostgREST + Storage) built on httpx.

Only what the hub needs. Signs in as the hub device user with email/password,
refreshes the access token before it expires, and falls back to a fresh
password sign-in if the refresh token is rejected. Never uses a service key.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)


class SupabaseError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"Supabase {status}: {message}")
        self.status = status


@dataclass
class _Session:
    access_token: str
    refresh_token: str
    expires_at: float  # unix seconds


class SupabaseClient:
    def __init__(
        self,
        url: str,
        anon_key: str,
        email: str,
        password: str,
        timeout: float = 20.0,
        http: httpx.Client | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self._email = email
        self._password = password
        self._http = http or httpx.Client(timeout=httpx.Timeout(timeout, read=120.0))
        self._session: _Session | None = None

    # --- auth -------------------------------------------------------------

    def _token_request(self, grant_type: str, body: dict[str, str]) -> _Session:
        r = self._http.post(
            f"{self.url}/auth/v1/token",
            params={"grant_type": grant_type},
            json=body,
            headers={"apikey": self.anon_key},
        )
        if r.status_code >= 400:
            raise SupabaseError(r.status_code, _error_text(r))
        data = r.json()
        return _Session(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=time.time() + float(data.get("expires_in", 3600)),
        )

    def sign_in(self) -> None:
        log.info("Signing in to Supabase as %s", self._email)
        self._session = self._token_request(
            "password", {"email": self._email, "password": self._password}
        )

    def _refresh(self) -> None:
        if self._session is None:
            self.sign_in()
            return
        try:
            self._session = self._token_request(
                "refresh_token", {"refresh_token": self._session.refresh_token}
            )
            log.debug("Refreshed access token")
        except SupabaseError as e:
            # Refresh tokens are single-use and expire; a password sign-in always recovers.
            log.warning("Token refresh failed (%s); signing in again", e)
            self.sign_in()

    def _ensure_session(self) -> _Session:
        if self._session is None:
            self.sign_in()
        elif self._session.expires_at - time.time() < 120:
            self._refresh()
        assert self._session is not None
        return self._session

    # --- generic request with one auth retry --------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        for attempt in (1, 2):
            session = self._ensure_session()
            h = {
                "apikey": self.anon_key,
                "Authorization": f"Bearer {session.access_token}",
                **(headers or {}),
            }
            r = self._http.request(method, f"{self.url}{path}", params=params, json=json, headers=h)
            if r.status_code == 401 and attempt == 1:
                log.info("Got 401; refreshing session and retrying")
                self._refresh()
                continue
            if r.status_code >= 400:
                raise SupabaseError(r.status_code, _error_text(r))
            return r
        raise AssertionError("unreachable")

    # --- PostgREST helpers ------------------------------------------------

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        r = self.request("GET", f"/rest/v1/{table}", params=params)
        return list(r.json())

    def update(
        self, table: str, filters: dict[str, str], values: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """PATCH rows matching `filters`; returns the updated rows (empty = nothing matched)."""
        r = self.request(
            "PATCH",
            f"/rest/v1/{table}",
            params=filters,
            json=values,
            headers={"Prefer": "return=representation"},
        )
        return list(r.json())

    def upsert(self, table: str, values: dict[str, Any]) -> None:
        self.request(
            "POST",
            f"/rest/v1/{table}",
            json=values,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )

    # --- Storage ----------------------------------------------------------

    def download(self, bucket: str, path: str, dest: Path) -> None:
        session = self._ensure_session()
        url = f"{self.url}/storage/v1/object/authenticated/{bucket}/{quote(path)}"
        headers = {"apikey": self.anon_key, "Authorization": f"Bearer {session.access_token}"}
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with self._http.stream("GET", url, headers=headers) as r:
            if r.status_code >= 400:
                r.read()
                raise SupabaseError(r.status_code, _error_text(r))
            with tmp.open("wb") as f:
                for chunk in r.iter_bytes(1 << 16):
                    f.write(chunk)
        tmp.replace(dest)

    def remove(self, bucket: str, path: str) -> None:
        self.request("DELETE", f"/storage/v1/object/{bucket}/{quote(path)}")

    def close(self) -> None:
        self._http.close()


def _error_text(r: httpx.Response) -> str:
    try:
        data = r.json()
    except ValueError:
        return r.text[:300]
    if isinstance(data, dict):
        for key in ("message", "msg", "error_description", "error"):
            if data.get(key):
                return str(data[key])
    return str(data)[:300]
