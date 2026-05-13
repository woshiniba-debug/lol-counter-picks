"""OP.GG RSC scraper — counters & runes.

OP.GG renders pages via Next.js streaming server components (RSC).
The HTML contains many `self.__next_f.push([1, "...escaped JSON..."])`
calls. We concatenate every payload, then locate the JSON arrays we
need by anchoring on a small structural probe (e.g. `"play":...,"win":...`)
and bracket-matching outward.

Two improvements over the original implementation:
1. Unescape uses `json.loads('"' + chunk + '"')` instead of a hand-rolled
   chain of `.replace()` calls. The chained replaces had ordering bugs
   (`\\\\"` was destructively replaced *before* `\\"`), occasionally
   corrupting payloads with literal backslashes. json.loads handles the
   full JS string-escape grammar — including \\uXXXX — correctly.
2. JSON array extraction now uses a real bracket-matching parser that
   respects string literals, so `]` inside a string can't terminate it
   prematurely. The previous O(n²) "try increasingly large slices" loop
   is replaced with one O(n) pass.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from cache import cache
from http_client import session


# ── Constants ────────────────────────────────────────────────────────────────

VALID_POSITIONS: frozenset[str] = frozenset(
    {"top", "jungle", "mid", "bottom", "support"}
)
VALID_TIERS: frozenset[str] = frozenset(
    {"gold_minus", "platinum_plus", "diamond_plus"}
)
DERIVED_TIER = "plat_to_emerald"  # computed as platinum_plus minus diamond_plus

# Bayesian confidence weight: virtual baseline games at 50% WR.
# Higher → stronger penalty for low sample sizes. 200 chosen empirically:
# a champion with ~50 games and 40% WR ends up scored ~48%, demoting it
# below higher-sample 47% counters without burying it entirely.
CONFIDENCE_WEIGHT = 200

COUNTERS_TTL = 1800
RUNES_TTL = 1800

# Thread pool for parallel scraping (used by plat_to_emerald derivation).
# Sized small — we don't want to hammer OP.GG.
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="opgg")


# ── Public scoring helper ────────────────────────────────────────────────────

def confidence_score(win_rate: float, play: int) -> float:
    """Bayesian average pulling low-sample entries toward 50%.

    `win_rate` is in percentage form (e.g. 47.3, not 0.473). Returned in
    the same scale. Sort ascending: best counter (lowest opponent WR) first.
    """
    wr_norm = win_rate / 100.0
    score = (CONFIDENCE_WEIGHT * 0.5 + play * wr_norm) / (CONFIDENCE_WEIGHT + play)
    return round(score * 100, 4)


# ── RSC fetch + decode ───────────────────────────────────────────────────────

_RSC_PUSH_RE = re.compile(
    r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)',
    re.DOTALL,
)


def _fetch_rsc(url: str) -> str:
    """Fetch an OP.GG page and return all RSC payloads, concatenated & unescaped."""
    resp = session.get(url, timeout=20)
    resp.raise_for_status()

    parts: list[str] = []
    for match in _RSC_PUSH_RE.finditer(resp.text):
        chunk = match.group(1)
        try:
            # The captured chunk is a JS string literal body. Wrapping in
            # quotes and calling json.loads decodes \", \\, \n, \\uXXXX, etc.
            # correctly in one pass — replacing the original brittle chain.
            parts.append(json.loads(f'"{chunk}"'))
        except json.JSONDecodeError:
            # Skip malformed chunk rather than aborting the whole page.
            continue
    return "\n".join(parts)


# ── JSON array extraction ────────────────────────────────────────────────────

def _extract_json_array(text: str, start: int) -> list | None:
    """Parse a JSON array starting at index `start` in `text`.

    Walks the string once with proper handling of string literals and
    escapes, so a `]` inside a JSON string doesn't break us. Returns the
    parsed list, or None if no balanced array was found.
    """
    if start < 0 or start >= len(text) or text[start] != "[":
        return None

    depth = 0
    in_string = False
    escape = False

    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


# ── URL builders ─────────────────────────────────────────────────────────────

def _counter_url(champion_id: str, position: str, tier: str) -> str:
    pos = f"/{position}" if position in VALID_POSITIONS else ""
    qs = f"?tier={tier}" if tier in VALID_TIERS else ""
    return f"https://op.gg/lol/champions/{champion_id.lower()}/counters{pos}{qs}"


def _runes_url(champion_id: str, position: str) -> str:
    pos = f"/{position}" if position in VALID_POSITIONS else ""
    return f"https://op.gg/lol/champions/{champion_id.lower()}/runes{pos}"


# ── Counters ─────────────────────────────────────────────────────────────────

# Anchor probe: the first counter object always has play/win/win_rate triplet.
# Compiled once for reuse — counter pages are fetched per request.
_COUNTER_ANCHOR_RE = re.compile(r'"play":\d+,"win":\d+,"win_rate":\d')


def _parse_counter_item(item: Any) -> dict | None:
    """Shape an OP.GG counter entry into our canonical dict."""
    if not isinstance(item, dict) or "champion" not in item:
        return None
    champ = item.get("champion") or {}
    play = item.get("play", 0)
    win = item.get("win", 0)
    wr = item.get("win_rate", 50)
    return {
        "play": play,
        "win": win,
        "win_rate": wr,
        "confidence_score": confidence_score(wr, play),
        "champion": {
            "name": champ.get("name", ""),
            "key": champ.get("key", ""),
            "image_url": champ.get("image_url", ""),
        },
    }


def _scrape_counters_raw(champion_id: str, position: str, tier: str) -> list[dict]:
    """Fetch & parse one OP.GG counter page (no sorting, no derivation)."""
    combined = _fetch_rsc(_counter_url(champion_id, position, tier))

    anchor = _COUNTER_ANCHOR_RE.search(combined)
    if not anchor:
        return []

    # Walk left to the enclosing '['. Using rfind is faster than per-char loop.
    bracket_idx = combined.rfind("[", 0, anchor.start())
    if bracket_idx < 0:
        return []

    items = _extract_json_array(combined, bracket_idx) or []
    return [parsed for item in items if (parsed := _parse_counter_item(item))]


def _derive_plat_to_emerald(plat: list[dict], dia: list[dict]) -> list[dict]:
    """Subtract diamond_plus sample from platinum_plus to isolate Plat-Emerald."""
    dia_by_key = {item["champion"]["key"]: item for item in dia}

    derived: list[dict] = []
    for item in plat:
        key = item["champion"]["key"]
        d = dia_by_key.get(key)

        if d and item["play"] > d["play"]:
            play = item["play"] - d["play"]
            win = item["win"] - d["win"]
            wr = round(win / play * 100, 2) if play > 0 else 50.0
        else:
            # No diamond sample (or non-positive after subtraction) — fall back.
            play, win, wr = item["play"], item["win"], item["win_rate"]

        derived.append({
            "play": play,
            "win": win,
            "win_rate": wr,
            "confidence_score": confidence_score(wr, play),
            "champion": item["champion"],
        })
    return derived


def get_counters(champion_id: str, position: str = "", tier: str = "") -> list[dict]:
    """Public API: cached, sorted counter list.

    Sort order is ascending by confidence_score — best counter (= opponent's
    lowest adjusted win rate) first.
    """
    cache_key = f"counters_{champion_id.lower()}_{position}_{tier}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    if tier == DERIVED_TIER:
        # Fetch the two base tiers in parallel — they are independent and
        # the original sequential version doubled p99 latency unnecessarily.
        plat_future = _executor.submit(
            _scrape_counters_raw, champion_id, position, "platinum_plus"
        )
        dia_future = _executor.submit(
            _scrape_counters_raw, champion_id, position, "diamond_plus"
        )
        result = _derive_plat_to_emerald(plat_future.result(), dia_future.result())
    else:
        result = _scrape_counters_raw(champion_id, position, tier)

    result.sort(key=lambda x: x["confidence_score"])
    cache.set(cache_key, result, ttl=COUNTERS_TTL)
    return result


# ── Runes ────────────────────────────────────────────────────────────────────

# Match start of the rune_pages array, including the first object's opening
# brace so we don't accidentally hit a label like `"rune_pages":"..."`.
_RUNES_ANCHOR_RE = re.compile(r'"rune_pages":\[(?=\{"id":\d+)')


def get_runes(champion_id: str, position: str = "") -> list[dict]:
    """Public API: cached rune pages for a champion / position."""
    cache_key = f"runes_{champion_id.lower()}_{position}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    combined = _fetch_rsc(_runes_url(champion_id, position))
    result: list[dict] = []

    anchor = _RUNES_ANCHOR_RE.search(combined)
    if anchor:
        # Anchor matches up to (but not past) the opening '['. Skip the
        # `"rune_pages":` prefix to land directly on `[`.
        bracket_idx = combined.find("[", anchor.start())
        if bracket_idx >= 0:
            parsed = _extract_json_array(combined, bracket_idx)
            if parsed:
                result = parsed

    cache.set(cache_key, result, ttl=RUNES_TTL)
    return result
