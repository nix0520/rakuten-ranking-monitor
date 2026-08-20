#!/usr/bin/env python3
"""Fetch Rakuten ranking data and maintain a compact 30-day rank history."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

API_URL = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601"


def load_jst(zone_factory: Callable[[str], Any] = ZoneInfo) -> Any:
    """Use IANA tzdata when available and a fixed JST offset on Windows otherwise."""
    try:
        return zone_factory("Asia/Tokyo")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=9), name="JST")


JST = load_jst()
ROOT = Path(__file__).resolve().parents[1]
ELEMENTS = ",".join(
    [
        "rank", "itemName", "itemCode", "itemPrice", "itemUrl", "mediumImageUrls",
        "reviewCount", "reviewAverage", "shopName", "shopCode", "shopUrl", "genreId",
    ]
)


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RuntimeError(f"Cannot read JSON: {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    temporary.replace(path)


def validate_categories(categories: list[dict[str, Any]]) -> None:
    ids = [int(category["id"]) for category in categories]
    if len(categories) != 17:
        raise ValueError(f"Expected exactly 17 categories, found {len(categories)}")
    if len(set(ids)) != len(ids):
        raise ValueError("Category IDs must be unique")
    if {category.get("group") for category in categories} != {"bra", "shorts"}:
        raise ValueError("Categories must contain both bra and shorts groups")


def image_url(value: Any) -> str:
    if not value:
        return ""
    first = value[0] if isinstance(value, list) else value
    if isinstance(first, dict):
        return str(first.get("imageUrl") or first.get("url") or "")
    return str(first)


def normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": int(item.get("rank") or 0),
        "itemName": str(item.get("itemName") or ""),
        "itemCode": str(item.get("itemCode") or ""),
        "itemPrice": int(float(item.get("itemPrice") or 0)),
        "itemUrl": str(item.get("itemUrl") or ""),
        "imageUrl": image_url(item.get("mediumImageUrls")),
        "reviewCount": int(item.get("reviewCount") or 0),
        "reviewAverage": float(item.get("reviewAverage") or 0),
        "shopName": str(item.get("shopName") or ""),
        "shopCode": str(item.get("shopCode") or ""),
        "shopUrl": str(item.get("shopUrl") or ""),
    }


def api_request(
    genre_id: int,
    page: int,
    application_id: str,
    access_key: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    attempts: int = 5,
) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "applicationId": application_id,
            "accessKey": access_key,
            "genreId": genre_id,
            "page": page,
            "format": "json",
            "formatVersion": 2,
            "elements": ELEMENTS,
        }
    )
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": "rakuten-ranking-monitor/1.0"},
    )
    for attempt in range(attempts):
        try:
            with opener(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == attempts - 1:
                body = exc.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"Rakuten API HTTP {exc.code}: {body}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == attempts - 1:
                raise RuntimeError(f"Rakuten API request failed: {exc}") from exc
        time.sleep(min(2**attempt + random.random(), 12))
    raise AssertionError("unreachable")


def fetch_category(
    category: dict[str, Any],
    application_id: str,
    access_key: str,
    request_fn: Callable[[int, int, str, str], dict[str, Any]] = api_request,
) -> tuple[list[dict[str, Any]], str | None]:
    collected: list[dict[str, Any]] = []
    source_build_at: str | None = None
    for page in range(1, 5):
        payload = request_fn(int(category["id"]), page, application_id, access_key)
        source_build_at = source_build_at or payload.get("lastBuildDate")
        raw_items = payload.get("Items") or payload.get("items") or []
        page_items = [entry.get("Item", entry.get("item", entry)) for entry in raw_items]
        collected.extend(normalize_item(item) for item in page_items if isinstance(item, dict))
        if len(page_items) < 30:
            break
        time.sleep(0.25)
    unique: dict[str, dict[str, Any]] = {}
    for item in sorted(collected, key=lambda value: value["rank"]):
        code = item["itemCode"]
        if code and code not in unique and 1 <= item["rank"] <= 100:
            unique[code] = item
    return list(unique.values())[:100], source_build_at


def previous_ranks(history: dict[str, Any]) -> dict[str, dict[str, int]]:
    captures = history.get("captures") or []
    return captures[-1].get("genres", {}) if captures else {}


def annotate_changes(
    rankings: dict[str, list[dict[str, Any]]], previous: dict[str, dict[str, int]]
) -> None:
    for genre_id, items in rankings.items():
        prior = previous.get(genre_id, {})
        for item in items:
            old_rank = prior.get(item["itemCode"])
            item["previousRank"] = old_rank
            item["change"] = old_rank - item["rank"] if old_rank is not None else None
            item["isNew"] = old_rank is None


def update_history(
    history: dict[str, Any], rankings: dict[str, list[dict[str, Any]]], captured_at: datetime
) -> dict[str, Any]:
    capture = {
        "capturedAt": captured_at.isoformat(timespec="seconds"),
        "genres": {
            genre_id: {item["itemCode"]: item["rank"] for item in items if item["itemCode"]}
            for genre_id, items in rankings.items()
        },
    }
    cutoff = captured_at - timedelta(days=30)
    retained = []
    for existing in history.get("captures") or []:
        try:
            when = datetime.fromisoformat(existing["capturedAt"])
            if when.tzinfo is None:
                when = when.replace(tzinfo=JST)
            if when >= cutoff:
                retained.append(existing)
        except (KeyError, TypeError, ValueError):
            continue
    retained.append(capture)
    return {"captures": retained}


def fixture_request(path: Path) -> Callable[[int, int, str, str], dict[str, Any]]:
    payload = load_json(path, {})

    def request(_genre_id: int, page: int, _application_id: str, _access_key: str) -> dict[str, Any]:
        return payload if page == 1 else {"Items": []}

    return request


def run(args: argparse.Namespace) -> None:
    categories = load_json(Path(args.categories), [])
    validate_categories(categories)
    output_dir = Path(args.output_dir)
    latest_path = output_dir / "latest.json"
    history_path = output_dir / "history.json"
    history = load_json(history_path, {"captures": []})

    if args.fixture:
        application_id, access_key = "fixture", "fixture"
        request_fn = fixture_request(Path(args.fixture))
    else:
        application_id = os.environ.get("RAKUTEN_APPLICATION_ID", "").strip()
        access_key = os.environ.get("RAKUTEN_ACCESS_KEY", "").strip()
        if not application_id or not access_key:
            raise RuntimeError("RAKUTEN_APPLICATION_ID and RAKUTEN_ACCESS_KEY are required")
        request_fn = api_request

    rankings: dict[str, list[dict[str, Any]]] = {}
    source_build_at = None
    for index, category in enumerate(categories, start=1):
        print(f"[{index:02d}/17] Fetching {category['id']} {category['name']}", flush=True)
        items, build_at = fetch_category(category, application_id, access_key, request_fn)
        rankings[str(category["id"])] = items
        source_build_at = source_build_at or build_at

    annotate_changes(rankings, previous_ranks(history))
    captured_at = datetime.now(JST).replace(microsecond=0)
    latest = {
        "generatedAt": captured_at.isoformat(),
        "sourceBuildAt": source_build_at,
        "categories": categories,
        "rankings": rankings,
    }
    write_json(latest_path, latest)
    write_json(history_path, update_history(history, rankings, captured_at))
    print(f"Saved {sum(map(len, rankings.values()))} ranking rows at {captured_at.isoformat()}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--categories", default=str(ROOT / "config" / "categories.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "data"))
    parser.add_argument("--fixture", help="Use one local API response fixture instead of the network")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        run(parse_args(sys.argv[1:]))
    except Exception as exc:  # GitHub Actions should fail loudly without leaking secrets.
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
