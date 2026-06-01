"""Flask entry point — routes only.

All scraping, caching, and data-source logic lives in dedicated modules
(`cache`, `http_client`, `riot`, `opgg`). This file is intentionally
thin: when OP.GG's HTML structure changes (it does), you only touch
`opgg.py` — not the HTTP layer or the route handlers.
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Any

from flask import Flask, jsonify, render_template, request

import opgg
import riot


def _resource_base() -> str:
    """Directory that holds `templates/` and `static/`.

    When packaged with PyInstaller the data files are unpacked next to the
    executable (onedir) or into a temp dir (onefile), exposed via
    `sys._MEIPASS`. In a normal `python app.py` run it's just this file's
    directory. Resolving it explicitly keeps Flask working in both modes.
    """
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


_BASE = _resource_base()
app = Flask(
    __name__,
    template_folder=os.path.join(_BASE, "templates"),
    static_folder=os.path.join(_BASE, "static"),
)

# Module-level logger so users can wire their own handlers in production
# without touching this file. Flask's logger is per-app and noisier.
log = logging.getLogger("lol_counter")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _json_ok(data: Any, **extra: Any):
    """Uniform success envelope. Keeping the `{success, data}` shape the
    frontend already expects — changing it would be a breaking API change.
    """
    return jsonify({"success": True, "data": data, **extra})


def _json_error(message: str, status: int = 500):
    return jsonify({"success": False, "error": message}), status


def _clean_position() -> str:
    pos = (request.args.get("position") or "").lower().strip()
    return pos if pos in opgg.VALID_POSITIONS else ""


def _clean_tier() -> str:
    tier = (request.args.get("tier") or "").lower().strip()
    if tier in opgg.VALID_TIERS or tier == opgg.DERIVED_TIER:
        return tier
    return ""


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def api_health():
    """Liveness probe — useful for uptime monitors and Docker healthchecks.

    Doesn't touch upstream services so it stays cheap and won't false-fail
    when OP.GG is degraded.
    """
    return _json_ok({"status": "ok"})


@app.route("/api/champions")
def api_champions():
    try:
        return _json_ok(riot.get_champions(), version=riot.get_version())
    except Exception as exc:  # noqa: BLE001 — surface upstream errors as JSON
        log.exception("Failed to load champions")
        return _json_error(str(exc))


@app.route("/api/counters/<champion_id>")
def api_counters(champion_id: str):
    position = _clean_position()
    tier = _clean_tier()
    try:
        return _json_ok(opgg.get_counters(champion_id, position, tier))
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to scrape counters for %s", champion_id)
        return _json_error(str(exc))


@app.route("/api/dual-counters/<champion_a>/<champion_b>")
def api_dual_counters(champion_a: str, champion_b: str):
    """Picks that counter both champions — for flex/swing-lane blind picks."""
    position = _clean_position()
    tier = _clean_tier()
    try:
        return _json_ok(
            opgg.get_dual_counters(champion_a, champion_b, position, tier)
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to scrape dual counters for %s + %s", champion_a, champion_b)
        return _json_error(str(exc))


@app.route("/api/runes/<champion_id>")
def api_runes(champion_id: str):
    position = _clean_position()
    try:
        return _json_ok(opgg.get_runes(champion_id, position))
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to scrape runes for %s", champion_id)
        return _json_error(str(exc))


# ── Cache-control for static assets ──────────────────────────────────────────

@app.after_request
def _set_cache_headers(response):
    """Tell browsers to cache static JS/CSS/img aggressively.

    Without this, the dev server returns no Cache-Control and the browser
    re-validates pinyin.js and main.js on every reload. Since we have no
    build hash, we use a short max-age + must-revalidate so a user
    refreshing still picks up new code within minutes.
    """
    if request.path.startswith("/static/"):
        response.headers.setdefault(
            "Cache-Control", "public, max-age=300, must-revalidate"
        )
    return response


if __name__ == "__main__":
    # Threaded=True lets the parallel plat_to_emerald fetcher actually run
    # in parallel against the dev server's request thread. Debug stays on
    # for local hacking — flip to False (or use a WSGI server) in prod.
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
