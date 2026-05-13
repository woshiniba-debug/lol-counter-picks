"""Thread-safe TTL in-memory cache.

Extracted from app.py so that the cache is reusable across modules
(scraper, riot loader) without circular imports. A single global
`Cache` instance is exposed as `cache` — keep it simple, no Redis dep.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class _Entry:
    data: Any
    expires_at: float


class Cache:
    """TTL cache safe for concurrent Flask workers.

    The original code used a bare dict. That's fine under CPython's GIL
    for single-key reads/writes, but `get_or_set` requires a check-then-act
    that must be atomic to avoid duplicate upstream fetches under load.
    """

    def __init__(self) -> None:
        self._store: dict[str, _Entry] = {}
        # RLock so a callable passed to get_or_set may itself touch the cache.
        self._lock = threading.RLock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if entry.expires_at < time.monotonic():
                # Lazy eviction — cheaper than a sweeper thread for our scale.
                self._store.pop(key, None)
                return None
            return entry.data

    def set(self, key: str, data: Any, ttl: int) -> None:
        with self._lock:
            self._store[key] = _Entry(data=data, expires_at=time.monotonic() + ttl)

    def get_or_set(self, key: str, factory: Callable[[], Any], ttl: int) -> Any:
        """Return cached value or compute & store via `factory`.

        Note: we release the lock while calling `factory` to avoid holding
        it across slow network I/O. A small race may cause two concurrent
        requests to both fetch — acceptable trade-off vs. global stall.
        """
        cached = self.get(key)
        if cached is not None:
            return cached
        value = factory()
        self.set(key, value, ttl)
        return value

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


cache = Cache()
