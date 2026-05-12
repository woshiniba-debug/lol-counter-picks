from flask import Flask, render_template, jsonify
import requests
import time

app = Flask(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.op.gg/",
    "Origin": "https://www.op.gg",
}

_cache: dict = {}


def cached_get(key: str, url: str, params: dict | None = None, ttl: int = 3600) -> dict:
    now = time.time()
    if key in _cache and now - _cache[key]["time"] < ttl:
        return _cache[key]["data"]
    resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    _cache[key] = {"data": data, "time": now}
    return data


def get_version() -> str:
    data = cached_get("version", "https://ddragon.leagueoflegends.com/api/versions.json")
    return data[0]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/champions")
def api_champions():
    try:
        version = get_version()
        raw = cached_get(
            "champions",
            f"https://ddragon.leagueoflegends.com/cdn/{version}/data/zh_CN/champion.json",
        )
        champions = []
        for champ in raw["data"].values():
            champions.append({
                "id": champ["id"],
                "key": int(champ["key"]),
                "name": champ["name"],
                "title": champ["title"],
                "image": champ["image"]["full"],
            })
        champions.sort(key=lambda x: x["name"])
        return jsonify({"success": True, "data": champions, "version": version})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/counters/<champion_id>")
def api_counters(champion_id):
    try:
        key = champion_id.lower()
        url = f"https://www.op.gg/api/v1/apps/lol/champions/{key}/counters"
        params = {"hl": "zh_CN", "region": "global"}
        data = cached_get(f"counters_{key}", url, params=params, ttl=1800)
        return jsonify({"success": True, "data": data})
    except requests.HTTPError as e:
        code = e.response.status_code
        return jsonify({"success": False, "error": f"OP.GG 接口错误: {code}"}), code
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/runes/<champion_id>")
def api_runes(champion_id):
    try:
        key = champion_id.lower()
        url = f"https://www.op.gg/api/v1/apps/lol/champions/{key}/runes"
        params = {"hl": "zh_CN", "region": "global"}
        data = cached_get(f"runes_{key}", url, params=params, ttl=1800)
        return jsonify({"success": True, "data": data})
    except requests.HTTPError as e:
        code = e.response.status_code
        return jsonify({"success": False, "error": f"OP.GG 接口错误: {code}"}), code
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
