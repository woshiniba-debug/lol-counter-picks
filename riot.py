"""Riot Data Dragon client — champion list & version lookup.

This is a stable, public CDN with no scraping involved, so the logic is
short. Kept separate from the OP.GG scraper to make the dependency graph
obvious: `app` -> `riot` (clean) and `app` -> `opgg` (fragile).
"""
from __future__ import annotations

from typing import TypedDict

from cache import cache
from http_client import session


_VERSION_URL = "https://ddragon.leagueoflegends.com/api/versions.json"
_CHAMPION_URL = (
    "https://ddragon.leagueoflegends.com/cdn/{version}/data/zh_CN/champion.json"
)

# Data Dragon versions and champion data both change ~weekly. 24h cache is fine.
_VERSION_TTL = 86_400
_CHAMPIONS_TTL = 86_400


class Champion(TypedDict):
    id: str
    key: int
    name: str
    title: str
    image: str


def get_version() -> str:
    def _fetch() -> str:
        resp = session.get(_VERSION_URL, timeout=10)
        resp.raise_for_status()
        return resp.json()[0]

    return cache.get_or_set("dd_version", _fetch, ttl=_VERSION_TTL)


def get_champions() -> list[Champion]:
    def _fetch() -> list[Champion]:
        version = get_version()
        resp = session.get(_CHAMPION_URL.format(version=version), timeout=10)
        resp.raise_for_status()
        raw = resp.json()
        champions: list[Champion] = [
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
        return champions

    return cache.get_or_set("dd_champions", _fetch, ttl=_CHAMPIONS_TTL)
