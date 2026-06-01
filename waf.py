"""AWS WAF challenge solver for OP.GG.

OP.GG sits behind AWS WAF, which serves a *silent* JS proof-of-work challenge
(HTTP 202 + a `gokuProps` bootstrap page) to clients that can't run JavaScript —
which includes plain `requests`. A real browser runs the challenge script,
is granted an `aws-waf-token` cookie, and is then let through. We verified that
this token is **cookie-scoped, not TLS-fingerprint-bound**: a plain `requests`
call carrying the cookie (with a matching User-Agent) gets a normal 200.

So Playwright's headless Chromium is used purely as a *token minter*: solve the
challenge once, harvest `aws-waf-token`, inject it into the shared requests
session, and keep all real scraping on the fast requests path. We only re-mint
when a challenge response reappears (token expired). Minting is serialised
behind a lock and de-duplicated by time, so a burst of concurrent 202s triggers
at most one browser launch.

This keeps OP.GG working "like a normal browser would" without making every
request pay the cost of spinning up a browser.
"""
from __future__ import annotations

import logging
import threading
import time

from http_client import DEFAULT_HEADERS, session

log = logging.getLogger("lol_counter")

# Must match the session's UA — WAF binds the token to the User-Agent that
# solved the challenge.
_USER_AGENT = DEFAULT_HEADERS["User-Agent"]

# Any op.gg/lol page triggers (and clears) the challenge; the resulting token
# is scoped to the whole .op.gg domain, so one solve covers every endpoint.
_SOLVE_URL = "https://op.gg/lol/champions"

_lock = threading.Lock()
_last_refresh = 0.0
# If the token was refreshed within this window, assume it's still good and
# skip relaunching the browser (avoids a thundering herd of browser launches
# when several parallel scrapes all hit a 202 at once).
_REFRESH_DEDUP_SECONDS = 30


def is_challenge(resp) -> bool:
    """True if `resp` is an AWS WAF challenge page rather than real content."""
    if resp.status_code == 202:
        return True
    # Defensive: some WAF configs serve the bootstrap page with a 200.
    head = resp.text[:2000]
    return "awsWafCookieDomainList" in head or "gokuProps" in head


def refresh_token(reason_url: str = _SOLVE_URL) -> None:
    """Solve the WAF challenge in a headless browser and inject the resulting
    `aws-waf-token` cookie into the shared requests session.

    Thread-safe and time-deduplicated. Raises RuntimeError with actionable
    guidance if Playwright / Chromium isn't available.
    """
    global _last_refresh
    with _lock:
        if time.time() - _last_refresh < _REFRESH_DEDUP_SECONDS:
            return  # another thread just minted a fresh token; reuse it
        token = _solve(reason_url)
        if not token:
            raise RuntimeError(
                "未能从 OP.GG 取得 aws-waf-token（验证页可能升级为需要人工交互的 CAPTCHA）"
            )
        session.cookies.set("aws-waf-token", token, domain=".op.gg")
        _last_refresh = time.time()
        log.info("Refreshed aws-waf-token via headless browser")


def _launch_browser(p):
    """Launch a headless browser for the challenge.

    Prefer a browser already installed on the machine (Edge ships with every
    Windows 10/11; Chrome is common too) so the packaged app doesn't need to
    bundle ~150MB of Chromium. Fall back to Playwright's own Chromium if it was
    installed via `playwright install chromium`.
    """
    last_err = None
    for channel in ("msedge", "chrome"):
        try:
            return p.chromium.launch(channel=channel, headless=True)
        except Exception as exc:  # noqa: BLE001 — try the next browser
            last_err = exc
    try:
        return p.chromium.launch(headless=True)  # bundled Chromium, if present
    except Exception as exc:  # noqa: BLE001 — nothing worked; give clear advice
        raise RuntimeError(
            "无法启动浏览器来通过 OP.GG 的 WAF 验证：系统未找到 Edge / Chrome，"
            "也没有安装 Playwright 自带的 Chromium（可运行 playwright install chromium）"
        ) from (last_err or exc)


def _solve(url: str) -> str | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "OP.GG 需要通过 AWS WAF 验证，这依赖 Playwright。请安装："
            "pip install playwright 然后 playwright install chromium"
        ) from exc

    with sync_playwright() as p:
        browser = _launch_browser(p)
        try:
            ctx = browser.new_context(user_agent=_USER_AGENT, locale="zh-CN")
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            # Wait for the challenge to resolve into real content. If it times
            # out we still try to read the cookie — the token may be set even
            # before the data-bearing reload completes.
            try:
                page.wait_for_function(
                    "() => document.documentElement.outerHTML.includes('win_rate')",
                    timeout=20000,
                )
            except Exception:  # noqa: BLE001 — best-effort; cookie check below
                pass
            for cookie in ctx.cookies():
                if cookie["name"] == "aws-waf-token":
                    return cookie["value"]
            return None
        finally:
            browser.close()
