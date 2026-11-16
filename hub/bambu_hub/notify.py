"""Optional push notifications via ntfy.sh. Failures are logged, never raised."""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

log = logging.getLogger(__name__)


class Notifier(Protocol):
    def send(self, topic: str | None, title: str, message: str, priority: str = "default",
             tags: str = "") -> None: ...


class NtfyNotifier:
    def __init__(self, base_url: str = "https://ntfy.sh", timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout)

    def send(self, topic: str | None, title: str, message: str, priority: str = "default",
             tags: str = "") -> None:
        if not topic:
            return
        try:
            self._http.post(
                f"{self.base_url}/{topic}",
                content=message.encode(),
                headers={"Title": title, "Priority": priority, "Tags": tags},
            ).raise_for_status()
        except httpx.HTTPError as e:
            log.warning("ntfy notification failed: %s", e)


class NullNotifier:
    def send(self, topic: str | None, title: str, message: str, priority: str = "default",
             tags: str = "") -> None:
        log.debug("notify (disabled): %s - %s", title, message)
