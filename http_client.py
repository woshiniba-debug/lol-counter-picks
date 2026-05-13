"""Shared HTTP session for upstream fetches.

Using a single `requests.Session` gives us TCP/TLS connection pooling
across requests, which materially reduces latency when the same upstream
host is hit repeatedly (Data Dragon + OP.GG within one user session).

Brotli is intentionally NOT advertised in Accept-Encoding because the
`requests` library does not decode it transparently; the response body
would come back as opaque bytes and break our RSC text parsing.
"""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": _USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    # gzip+deflate only — see module docstring on Brotli.
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
}


def _build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(DEFAULT_HEADERS)

    # Retry transient upstream failures. OP.GG occasionally 502s during
    # their deploys; one extra try usually recovers without user-visible error.
    retry = Retry(
        total=2,
        backoff_factor=0.4,
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=16)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


session: requests.Session = _build_session()
