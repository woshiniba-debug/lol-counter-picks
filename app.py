import re
import json
import time

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# ── HTTP headers for scraping OP.GG ─────────────────────────────────────────
SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    # Omit Accept-Encoding so requests uses gzip (handled automatically).
    # Brotli (br) is NOT supported by requests and causes garbled responses.
    "Cache-Control": "no-cache",
}

_cache: dict = {}


def _set_cache(key: str, data, ttl: int = 1800) -> None:
    _cache[key] = {"data": data, "time": time.time(), "ttl": ttl}


def _get_cache(key: str):
    entry = _cache.get(key)
    if entry and time.time() - entry["time"] < entry["ttl"]:
        return entry["data"]
    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fetch_rsc_combined(url: str) -> str:
    """Fetch an OP.GG page and return all __next_f.push content concatenated."""
    resp = requests.get(url, headers=SCRAPE_HEADERS, timeout=20)
    resp.raise_for_status()
    html = resp.text

    # Each push call looks like: self.__next_f.push([1,"...escaped content..."])
    pattern = r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)'
    chunks = re.findall(pattern, html, re.DOTALL)

    # Unescape JavaScript string encoding (\\" -> ", \\\\ -> \, \\n -> newline)
    parts = []
    for chunk in chunks:
        unescaped = chunk.replace('\\\\"', '"').replace('\\"', '"') \
                         .replace('\\\\', '\\').replace('\\n', '\n') \
                         .replace('\\t', '\t')
        parts.append(unescaped)
    return "\n".join(parts)


def _extract_json_block(combined: str, key_probe: str) -> list | dict | None:
    """
    Find a JSON array/object in the RSC text that contains `key_probe`.
    Searches for the first occurrence of key_probe and walks outward to find
    the enclosing JSON structure.
    """
    idx = combined.find(key_probe)
    if idx < 0:
        return None

    # Walk left to find the opening '[' or '{'
    # The RSC slot format is like: 55:[...] or 55:{...}
    # Find the nearest '[' or '{' before idx
    start = idx
    while start > 0 and combined[start] not in ('[', '{'):
        start -= 1

    # Try to parse increasingly large slices from start
    for end in range(idx + len(key_probe), min(len(combined), idx + 200_000)):
        if combined[end] not in (']', '}'):
            continue
        candidate = combined[start:end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


# ── Data Dragon: champion list ────────────────────────────────────────────────

def _dd_version() -> str:
    cached = _get_cache("dd_version")
    if cached:
        return cached
    resp = requests.get(
        "https://ddragon.leagueoflegends.com/api/versions.json", timeout=10
    )
    resp.raise_for_status()
    ver = resp.json()[0]
    _set_cache("dd_version", ver, ttl=86400)
    return ver


def _dd_champions() -> list:
    cached = _get_cache("dd_champions")
    if cached:
        return cached
    version = _dd_version()
    resp = requests.get(
        f"https://ddragon.leagueoflegends.com/cdn/{version}/data/zh_CN/champion.json",
        timeout=10,
    )
    resp.raise_for_status()
    raw = resp.json()
    champions = [
        {
            "id": c["id"],
            "key": int(c["key"]),
            "name": c["name"],
            "title": c["title"],
            "image": c["image"]["full"],
        }
        for c in raw["data"].values()
    ]
    champions.sort(key=lambda x: x["name"])
    _set_cache("dd_champions", champions, ttl=86400)
    return champions


# ── OP.GG scraping ────────────────────────────────────────────────────────────

def _find_array(combined: str, start: int) -> list | None:
    """Extract a JSON array starting at position `start` in combined."""
    if start < 0 or start >= len(combined) or combined[start] != '[':
        return None
    depth = 0
    for i in range(start, len(combined)):
        ch = combined[i]
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(combined[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


VALID_POSITIONS = {"top", "jungle", "mid", "bottom", "support"}
VALID_TIERS = {"gold_minus", "platinum_plus", "diamond_plus"}

# Bayesian confidence weight: virtual baseline games at 50% WR.
# Higher → stronger penalty for low sample sizes.
_CONFIDENCE_WEIGHT = 200


def _confidence_score(win_rate: float, play: int) -> float:
    """
    Bayesian average that pulls low-sample entries toward 50% (no counter advantage).
    win_rate is in percentage form (e.g. 47.3), not 0–1.
    Returns a score in the same percentage form; sort ascending for best counters.
    """
    wr_norm = win_rate / 100.0
    score = (_CONFIDENCE_WEIGHT * 0.5 + play * wr_norm) / (_CONFIDENCE_WEIGHT + play)
    return round(score * 100, 4)


def _scrape_counters_raw(champion_id: str, position: str, tier: str) -> list:
    """Fetch and parse one OP.GG counter page. Returns unsorted raw list."""
    pos_path = f"/{position}" if position in VALID_POSITIONS else ""
    tier_qs = f"?tier={tier}" if tier in VALID_TIERS else ""
    url = f"https://op.gg/lol/champions/{champion_id.lower()}/counters{pos_path}{tier_qs}"
    combined = _fetch_rsc_combined(url)

    m = re.search(r'"play":\d+,"win":\d+,"win_rate":\d', combined)
    if not m:
        return []

    bracket_idx = combined.rfind('[', 0, m.start())
    if bracket_idx < 0:
        return []

    counters = _find_array(combined, bracket_idx)
    if not counters:
        return []

    result = []
    for item in counters:
        if not isinstance(item, dict) or "champion" not in item:
            continue
        champ = item.get("champion", {})
        play = item.get("play", 0)
        wr = item.get("win_rate", 50)
        result.append({
            "play": play,
            "win": item.get("win", 0),
            "win_rate": wr,
            "confidence_score": _confidence_score(wr, play),
            "champion": {
                "name": champ.get("name", ""),
                "key": champ.get("key", ""),
                "image_url": champ.get("image_url", ""),
            },
        })
    return result


def _scrape_counters(champion_id: str, position: str = "", tier: str = "") -> list:
    """
    Return counter list sorted ascending by confidence_score (best counter first).
    tier "plat_to_emerald" is derived by subtracting diamond_plus from platinum_plus.
    """
    if tier == "plat_to_emerald":
        return _compute_plat_to_emerald(champion_id, position)

    result = _scrape_counters_raw(champion_id, position, tier)
    result.sort(key=lambda x: x["confidence_score"])
    return result


def _compute_plat_to_emerald(champion_id: str, position: str) -> list:
    """
    Derive Platinum-to-Emerald stats:
      plat_to_emerald = platinum_plus − diamond_plus
    Win rate and confidence score are recomputed on the subtracted sample.
    """
    plat_list = _scrape_counters_raw(champion_id, position, "platinum_plus")
    dia_list = _scrape_counters_raw(champion_id, position, "diamond_plus")

    dia_by_key = {item["champion"]["key"]: item for item in dia_list}

    result = []
    for item in plat_list:
        key = item["champion"]["key"]
        d = dia_by_key.get(key)

        if d and item["play"] > d["play"]:
            play = item["play"] - d["play"]
            win = item["win"] - d["win"]
            wr = round(win / play * 100, 2) if play > 0 else 50.0
        else:
            play = item["play"]
            win = item["win"]
            wr = item["win_rate"]

        result.append({
            "play": play,
            "win": win,
            "win_rate": wr,
            "confidence_score": _confidence_score(wr, play),
            "champion": item["champion"],
        })

    result.sort(key=lambda x: x["confidence_score"])
    return result


def _scrape_runes(champion_id: str, position: str = "") -> list:
    """
    Scrape OP.GG rune page and return rune_pages list.
    Each page has: id, play, pick_rate, builds[{primary_perk_style, perk_sub_style,
    main_runes, sub_runes, stat_perks, win, play, pick_rate}]
    """
    pos_path = f"/{position}" if position in VALID_POSITIONS else ""
    url = f"https://op.gg/lol/champions/{champion_id.lower()}/runes{pos_path}"
    combined = _fetch_rsc_combined(url)

    # "rune_pages" appears as a key followed by an array containing rune page objects.
    # Locate the one where rune_pages value is an array of objects (not just a label).
    # The actual data looks like: "rune_pages":[{"id":8112,"play":...,"builds":[...]}]
    m = re.search(r'"rune_pages":\[(\{"id":\d+)', combined)
    if not m:
        return []

    bracket_idx = combined.find('[', m.start())
    if bracket_idx < 0:
        return []

    result = _find_array(combined, bracket_idx)
    return result if result else []


# ── Flask routes ──────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/champions")
def api_champions():
    try:
        version = _dd_version()
        champions = _dd_champions()
        return jsonify({"success": True, "data": champions, "version": version})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/counters/<champion_id>")
def api_counters(champion_id):
    position = request.args.get("position", "").lower().strip()
    tier = request.args.get("tier", "").lower().strip()
    if position not in VALID_POSITIONS:
        position = ""
    if tier not in VALID_TIERS and tier != "plat_to_emerald":
        tier = ""
    cache_key = f"counters_{champion_id.lower()}_{position}_{tier}"
    cached = _get_cache(cache_key)
    if cached is not None:
        return jsonify({"success": True, "data": cached})
    try:
        data = _scrape_counters(champion_id, position, tier)
        _set_cache(cache_key, data, ttl=1800)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/runes/<champion_id>")
def api_runes(champion_id):
    position = request.args.get("position", "").lower().strip()
    if position not in VALID_POSITIONS:
        position = ""
    cache_key = f"runes_{champion_id.lower()}_{position}"
    cached = _get_cache(cache_key)
    if cached is not None:
        return jsonify({"success": True, "data": cached})
    try:
        data = _scrape_runes(champion_id, position)
        _set_cache(cache_key, data, ttl=1800)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
