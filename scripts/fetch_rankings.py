#!/usr/bin/env python3
"""Fetch Rakuten ranking data and maintain a compact 30-day rank history."""

from __future__ import annotations

import argparse
import json
from email.utils import parsedate_to_datetime
import os
import random
import re
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
MAX_RANK = 1000
MAX_PAGES = 34
HISTORY_DAYS = 30
DAILY_COLLECTION_VERSION = 2
PROMOTION_PATTERN = re.compile(r"(?:クーポン|OFF|割引|値引|セール|ポイント(?:アップ|還元|倍))", re.IGNORECASE)
ELEMENTS = ",".join(
    [
        "lastBuildDate",
        "rank", "itemName", "itemCode", "itemPrice", "itemUrl", "mediumImageUrls",
        "reviewCount", "reviewAverage", "shopName", "shopCode", "shopUrl", "genreId",
        "catchcopy", "itemCaption", "startTime", "endTime", "pointRate",
        "pointRateStartTime", "pointRateEndTime",
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
    promotion_text = " ".join(
        str(item.get(field) or "") for field in ("catchcopy", "itemCaption", "itemName")
    )
    hints = list(dict.fromkeys(match.group(0) for match in PROMOTION_PATTERN.finditer(promotion_text)))
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
        "catchcopy": str(item.get("catchcopy") or ""),
        "saleStartAt": str(item.get("startTime") or ""),
        "saleEndAt": str(item.get("endTime") or ""),
        "pointRate": int(float(item.get("pointRate") or 1)),
        "pointRateStartAt": str(item.get("pointRateStartTime") or ""),
        "pointRateEndAt": str(item.get("pointRateEndTime") or ""),
        "promotionHints": hints[:8],
        "couponMentioned": any("クーポン" in hint for hint in hints),
    }


def api_request(
    genre_id: int,
    page: int,
    application_id: str,
    access_key: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    attempts: int = 5,
    period: str | None = None,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {
            "applicationId": application_id,
            "accessKey": access_key,
            "genreId": genre_id,
            "page": page,
            "format": "json",
            "formatVersion": 2,
            "elements": ELEMENTS,
    }
    if period:
        parameters["period"] = period
    query = urllib.parse.urlencode(parameters)
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": "rakuten-ranking-monitor/1.0"},
    )
    for attempt in range(attempts):
        try:
            with opener(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {"Items": [], "_notFound": True}
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
    sleep_fn: Callable[[float], None] = time.sleep,
    max_rank: int = MAX_RANK,
    period: str | None = None,
    expected_date: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    collected: list[dict[str, Any]] = []
    source_build_at: str | None = None
    max_pages = min(MAX_PAGES, (max_rank + 29) // 30)
    full_daily = period is None and max_rank > 30
    seen_codes: set[str] = set()
    for page in range(1, max_pages + 1):
        for attempt in range(3 if full_daily else 1):
            payload = request_fn(
                int(category["id"]), page, application_id, access_key, period=period
            )
            if payload.get("Items") or payload.get("items") or not full_daily or attempt == 2:
                break
            print(f"  Empty page {page}; retrying ({attempt + 1}/2)", flush=True)
            sleep_fn(1.0)
        if payload.get("_notFound"):
            print(
                f"  No ranking data for page {page}; keeping {len(collected)} rows",
                flush=True,
            )
            break
        source_build_at = source_build_at or payload.get("lastBuildDate")
        raw_items = payload.get("Items") or payload.get("items") or []
        if raw_items and expected_date and source_date(payload.get("lastBuildDate")) != expected_date:
            raise RuntimeError(f"Daily source date mismatch for genre {category['id']} page {page}")
        page_items = [entry.get("Item", entry.get("item", entry)) for entry in raw_items]
        normalized = [normalize_item(item) for item in page_items if isinstance(item, dict)]
        valid = [item for item in normalized if item["itemCode"] and 1 <= item["rank"] <= max_rank]
        if full_daily and page_items and not any(item["itemCode"] not in seen_codes for item in valid):
            raise RuntimeError(f"Daily page made no valid progress for genre {category['id']} page {page}")
        seen_codes.update(item["itemCode"] for item in valid)
        collected.extend(normalized)
        if not page_items or (not full_daily and len(page_items) < 30):
            break
        if valid and max(item["rank"] for item in valid) >= max_rank:
            break
        if page < max_pages:
            sleep_fn(1.0)
    unique: dict[str, dict[str, Any]] = {}
    for item in sorted(collected, key=lambda value: value["rank"]):
        code = item["itemCode"]
        if code and code not in unique and 1 <= item["rank"] <= max_rank:
            unique[code] = item
    return list(unique.values())[:max_rank], source_build_at


def capture_datetime(capture: dict[str, Any]) -> datetime | None:
    try:
        value = datetime.fromisoformat(capture["capturedAt"])
        return value.replace(tzinfo=JST) if value.tzinfo is None else value.astimezone(JST)
    except (KeyError, TypeError, ValueError):
        return None


def load_history_captures(output_dir: Path, history: dict[str, Any]) -> list[dict[str, Any]]:
    """Load both the legacy inline history and the date-partitioned format."""
    captures: list[dict[str, Any]] = []
    for entry in history.get("captures") or []:
        if isinstance(entry.get("genres"), dict):
            captures.append(entry)
            continue
        relative_path = entry.get("file")
        if not relative_path:
            continue
        capture = load_json(output_dir / str(relative_path), None)
        if isinstance(capture, dict) and isinstance(capture.get("genres"), dict):
            if not capture.get("aggregateDate") and entry.get("date"):
                capture["aggregateDate"] = entry["date"]
            captures.append(capture)
    return sorted(captures, key=lambda capture: capture.get("capturedAt", ""))


def capture_aggregate_date(capture: dict[str, Any]) -> str | None:
    aggregate_date = source_date(capture.get("aggregateDate"))
    if aggregate_date:
        return aggregate_date
    when = capture_datetime(capture)
    return when.date().isoformat() if when is not None else None


def previous_daily_ranks(
    captures: list[dict[str, Any]],
    captured_at: datetime,
    aggregate_date: str | None = None,
) -> dict[str, dict[str, int]]:
    current_date = aggregate_date or captured_at.astimezone(JST).date().isoformat()
    candidates = [
        capture
        for capture in captures
        if (day := capture_aggregate_date(capture)) is not None and day < current_date
    ]
    candidates.sort(key=lambda capture: capture_aggregate_date(capture) or "")
    return candidates[-1].get("genres", {}) if candidates else {}


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


def compact_ranks(rankings: dict[str, list[dict[str, Any]]], limit: int = 30) -> dict[str, dict[str, int]]:
    return {
        genre_id: {
            item["itemCode"]: item["rank"]
            for item in items
            if item.get("itemCode") and item.get("rank", 0) <= limit
        }
        for genre_id, items in rankings.items()
    }


def ranking_diff(
    current: dict[str, dict[str, int]], previous: dict[str, dict[str, int]]
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for genre_id in sorted(set(current) | set(previous)):
        now, before = current.get(genre_id, {}), previous.get(genre_id, {})
        entered = sorted(set(now) - set(before), key=lambda code: now[code])
        disappeared = sorted(set(before) - set(now), key=lambda code: before[code])
        moved = [
            {
                "itemCode": code,
                "previousRank": before[code],
                "rank": now[code],
                "change": before[code] - now[code],
            }
            for code in set(now) & set(before)
            if now[code] != before[code]
        ]
        moved.sort(key=lambda item: (-abs(item["change"]), item["rank"]))
        result[genre_id] = {
            "changedCount": len(moved),
            "entered": [{"itemCode": code, "rank": now[code]} for code in entered],
            "disappeared": [
                {"itemCode": code, "previousRank": before[code]} for code in disappeared
            ],
            "moved": moved,
        }
    return result


def source_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            match = re.search(r"\d{4}-\d{2}-\d{2}", value)
            return match.group(0) if match else None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST).date().isoformat()


def update_daily_observations(
    output_dir: Path,
    rankings: dict[str, list[dict[str, Any]]],
    captured_at: datetime,
    source_build_at: str | None,
) -> None:
    path = output_dir / "daily-update-log.json"
    log = load_json(path, {"days": []})
    days = [day for day in log.get("days", []) if isinstance(day, dict)]
    today = captured_at.date().isoformat()
    day = next((entry for entry in days if entry.get("date") == today), None)
    if day is None:
        day = {"date": today, "firstUpdateDetectedAt": None, "observations": []}
        days.append(day)

    ranks = compact_ranks(rankings)
    aggregate_date = source_date(source_build_at)
    all_observations = [
        observation
        for entry in days
        for observation in entry.get("observations", [])
        if isinstance(observation, dict)
    ]
    previous_observation = all_observations[-1] if all_observations else None
    previous_ranks = previous_observation.get("ranks", {}) if previous_observation else {}
    changed = bool(previous_observation) and (
        previous_observation.get("pageUpdatedAt") != source_build_at
        or previous_ranks != ranks
    )

    # A rollover is proven only once: when the API aggregate date first matches today.
    valid_update_seen = any(
        observation.get("aggregateDate") == today
        for observation in day.get("observations", [])
    )
    source_rolled_over = aggregate_date == today and not valid_update_seen
    if not valid_update_seen:
        day["firstUpdateDetectedAt"] = None
    if source_rolled_over:
        day["firstUpdateDetectedAt"] = captured_at.isoformat(timespec="seconds")

    # Daily movement must compare the new aggregate date with a prior aggregate date.
    # Repeated probes from the same day are observations only and never become baselines.
    prior_daily_observation = next(
        (
            observation
            for observation in reversed(all_observations)
            if observation.get("aggregateDate")
            and aggregate_date
            and observation.get("aggregateDate") < aggregate_date
        ),
        None,
    )
    changes = (
        ranking_diff(ranks, prior_daily_observation.get("ranks", {}))
        if source_rolled_over and prior_daily_observation
        else {}
    )
    observation = {
        "capturedAt": captured_at.isoformat(timespec="seconds"),
        "aggregateDate": aggregate_date,
        "pageUpdatedAt": source_build_at,
        "changed": changed,
        "dailyRollover": source_rolled_over,
        "changes": changes,
        "ranks": ranks,
    }
    day["aggregateDate"] = aggregate_date
    day["pageUpdatedAt"] = source_build_at
    day["observations"].append(observation)
    cutoff = captured_at.date() - timedelta(days=HISTORY_DAYS - 1)
    days = [entry for entry in days if entry.get("date", "") >= cutoff.isoformat()]
    write_json(path, {"days": days})


def promotion_diff(
    current: dict[str, list[dict[str, Any]]], previous: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for genre_id, items in current.items():
        now = {item["itemCode"]: item for item in items}
        before = {item["itemCode"]: item for item in previous.get(genre_id, [])}
        ranks = ranking_diff(
            {genre_id: {code: item["rank"] for code, item in now.items()}},
            {genre_id: {code: item["rank"] for code, item in before.items()}},
        )[genre_id]
        ranks["priceChanges"] = [
            {"itemCode": code, "before": before[code]["itemPrice"], "after": now[code]["itemPrice"]}
            for code in now.keys() & before.keys()
            if now[code]["itemPrice"] != before[code]["itemPrice"]
        ]
        ranks["pointChanges"] = [
            {"itemCode": code, "before": before[code].get("pointRate", 1), "after": now[code].get("pointRate", 1)}
            for code in now.keys() & before.keys()
            if now[code].get("pointRate", 1) != before[code].get("pointRate", 1)
        ]
        ranks["promotionChanges"] = [
            {"itemCode": code, "before": before[code].get("promotionHints", []), "after": now[code].get("promotionHints", [])}
            for code in now.keys() & before.keys()
            if now[code].get("promotionHints", []) != before[code].get("promotionHints", [])
        ]
        ranks["surgeSignals"] = [
            {
                "itemCode": move["itemCode"],
                "rank": move["rank"],
                "change": move["change"],
                "price": now[move["itemCode"]]["itemPrice"],
                "priceDropped": now[move["itemCode"]]["itemPrice"] < before[move["itemCode"]]["itemPrice"],
                "pointRate": now[move["itemCode"]].get("pointRate", 1),
                "pointIncreased": now[move["itemCode"]].get("pointRate", 1) > before[move["itemCode"]].get("pointRate", 1),
                "promotionHints": now[move["itemCode"]].get("promotionHints", []),
                "promotionChanged": now[move["itemCode"]].get("promotionHints", []) != before[move["itemCode"]].get("promotionHints", []),
            }
            for move in ranks["moved"]
            if move["change"] > 0
        ]
        result[genre_id] = ranks
    return result


def update_realtime(
    output_dir: Path,
    categories: list[dict[str, Any]],
    rankings: dict[str, list[dict[str, Any]]],
    captured_at: datetime,
    source_build_at: str | None,
) -> None:
    realtime_dir = output_dir / "realtime"
    latest_path = realtime_dir / "latest.json"
    previous = load_json(latest_path, {"rankings": {}})
    previous_ranks = {
        genre_id: {item["itemCode"]: item["rank"] for item in items if item.get("itemCode")}
        for genre_id, items in previous.get("rankings", {}).items()
    }
    annotate_changes(rankings, previous_ranks)
    for genre_id, items in rankings.items():
        old_items = {item["itemCode"]: item for item in previous.get("rankings", {}).get(genre_id, [])}
        for item in items:
            old = old_items.get(item["itemCode"], {})
            item["previousPrice"] = old.get("itemPrice")
            item["previousPointRate"] = old.get("pointRate")
            item["priceChange"] = item["itemPrice"] - old["itemPrice"] if item.get("itemPrice") is not None and old.get("itemPrice") is not None else None
            item["pointChange"] = item["pointRate"] - old["pointRate"] if item.get("pointRate") is not None and old.get("pointRate") is not None else None
    event = {
        "capturedAt": captured_at.isoformat(timespec="seconds"),
        "sourceBuildAt": source_build_at,
        "changes": promotion_diff(rankings, previous.get("rankings", {})),
    }
    day_path = realtime_dir / f"{captured_at.date().isoformat()}.json"
    day = load_json(day_path, {"date": captured_at.date().isoformat(), "events": []})
    day["events"].append(event)
    write_json(day_path, day)
    write_json(latest_path, {
        "generatedAt": captured_at.isoformat(timespec="seconds"),
        "previousCapturedAt": previous.get("generatedAt"),
        "sourceBuildAt": source_build_at,
        "categories": categories,
        "rankings": rankings,
    })
    cutoff = captured_at.date() - timedelta(days=HISTORY_DAYS - 1)
    for path in realtime_dir.glob("????-??-??.json"):
        if path.stem < cutoff.isoformat():
            path.unlink()


def update_history(
    output_dir: Path,
    captures: list[dict[str, Any]],
    rankings: dict[str, list[dict[str, Any]]],
    captured_at: datetime,
    aggregate_date: str,
) -> dict[str, Any]:
    current_capture = {
        "capturedAt": captured_at.isoformat(timespec="seconds"),
        "aggregateDate": aggregate_date,
        "rankLimit": MAX_RANK,
        "products": {
            item["itemCode"]: {
                field: item.get(field)
                for field in (
                    "itemName", "itemUrl", "imageUrl", "shopName", "shopCode", "shopUrl",
                    "catchcopy", "reviewCount", "reviewAverage", "couponMentioned",
                )
            }
            for items in rankings.values() for item in items if item.get("itemCode")
        },
        # Keep compact historical observations, never backfill old prices from latest.
        "metrics": {
            genre_id: {
                item["itemCode"]: {
                    "itemPrice": item.get("itemPrice"),
                    "pointRate": item.get("pointRate"),
                    "promotionHints": item.get("promotionHints", []),
                }
                for item in items if item.get("itemCode")
            }
            for genre_id, items in rankings.items()
        },
        "genres": {
            genre_id: {item["itemCode"]: item["rank"] for item in items if item["itemCode"]}
            for genre_id, items in rankings.items()
        },
    }
    current_date = captured_at.astimezone(JST).date()
    cutoff_date = current_date - timedelta(days=HISTORY_DAYS - 1)
    by_date: dict[str, dict[str, Any]] = {}
    for existing in [*captures, current_capture]:
        day = capture_aggregate_date(existing)
        if day and cutoff_date.isoformat() <= day <= current_date.isoformat():
            by_date[day] = existing

    # Descriptive product snapshots are lazy-loaded by the UI; keep rank history compact.
    product_day = capture_aggregate_date(current_capture)
    products = current_capture.pop("products")
    if product_day in by_date:
        current_capture["productsFile"] = f"history-products/{product_day}.json"
        write_json(output_dir / current_capture["productsFile"], {"products": products})
    products_dir = output_dir / "history-products"
    if products_dir.exists():
        for path in products_dir.glob("????-??-??.json"):
            if path.stem not in by_date:
                path.unlink()

    history_dir = output_dir / "history"
    history_dir.mkdir(parents=True, exist_ok=True)
    for day, capture in sorted(by_date.items()):
        write_json(history_dir / f"{day}.json", capture)

    for path in history_dir.glob("*.json"):
        try:
            day = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < cutoff_date or day > current_date:
            path.unlink()

    return {
        "captures": [
            {
                "date": day,
                "capturedAt": capture["capturedAt"],
                "file": f"history/{day}.json",
            }
            for day, capture in sorted(by_date.items())
        ]
    }


def fixture_request(path: Path) -> Callable[[int, int, str, str], dict[str, Any]]:
    payload = load_json(path, {})

    def request(
        _genre_id: int, page: int, _application_id: str, _access_key: str, **_kwargs: Any
    ) -> dict[str, Any]:
        return payload if page == 1 else {"Items": []}

    return request


class DailyCompletenessError(RuntimeError):
    def __init__(self, missing_genres: list[str]):
        self.missing_genres = missing_genres
        super().__init__("Daily data below same-day observed minimum for genres: " + ", ".join(missing_genres))


def daily_minimum_counts(output_dir: Path, aggregate_date: str | None) -> dict[str, int]:
    """Only same-aggregate-day evidence; never use yesterday as today's data."""
    if not aggregate_date:
        return {}
    counts: dict[str, int] = {}
    log = load_json(output_dir / "daily-update-log.json", {"days": []})
    for day in log.get("days", []):
        for observation in day.get("observations", []):
            if observation.get("aggregateDate") == aggregate_date:
                for genre, rows in observation.get("ranks", {}).items():
                    counts[genre] = max(counts.get(genre, 0), min(30, len(rows)))
    latest = load_json(output_dir / "latest.json", {})
    if latest.get("aggregateDate") == aggregate_date:
        for genre, rows in latest.get("rankings", {}).items():
            counts[genre] = max(counts.get(genre, 0), min(30, len(rows)))
    return counts


def record_auto_daily_fetch(output_dir: Path, aggregate_date: str, status: str,
                           missing_genres: list[str] | None = None) -> None:
    """Attach the automatic-fetch outcome to the initiating probe, without secrets."""
    path = output_dir / "daily-update-log.json"
    log = load_json(path, {"days": []})
    for day in reversed(log["days"]):
        for observation in reversed(day.get("observations", [])):
            attempt = observation.get("autoDailyFetch", {})
            if status != "running" and attempt.get("status") == "running" and attempt.get("aggregateDate") == aggregate_date:
                observation["autoDailyFetch"].update(
                    status=status, finishedAt=datetime.now(JST).isoformat(timespec="seconds")
                )
                if missing_genres:
                    observation["autoDailyFetch"].update(missingGenres=missing_genres, reason="missing_daily_rows")
                write_json(path, log)
                return
    if log["days"] and log["days"][-1].get("observations"):
        log["days"][-1]["observations"][-1]["autoDailyFetch"] = {
            "aggregateDate": aggregate_date, "status": status,
            "startedAt": datetime.now(JST).isoformat(timespec="seconds"),
        }
        if missing_genres:
            log["days"][-1]["observations"][-1]["autoDailyFetch"].update(
                missingGenres=missing_genres, reason="missing_daily_rows"
            )
        write_json(path, log)


def needs_auto_daily_fetch(output_dir: Path, aggregate_date: str | None, today: str,
                           categories: list[dict[str, Any]]) -> bool:
    if not aggregate_date or aggregate_date != today:
        return False
    latest = load_json(output_dir / "latest.json", {})
    published_date = source_date(latest.get("aggregateDate"))
    if published_date and published_date > aggregate_date:
        return False  # Never regress a newer published snapshot.
    expected = {str(category["id"]) for category in categories}
    complete = (
        latest.get("generatedAt") and published_date == aggregate_date
        and expected.issubset(latest.get("rankings", {}))
        and any(latest.get("rankings", {}).values())
        and latest.get("collectionVersion", 0) >= DAILY_COLLECTION_VERSION
        and all(len(latest.get("rankings", {}).get(genre, [])) >= count
                for genre, count in daily_minimum_counts(output_dir, aggregate_date).items())
    )
    return not complete


def run(args: argparse.Namespace, expected_daily_date: str | None = None) -> None:
    categories = load_json(Path(args.categories), [])
    validate_categories(categories)
    output_dir = Path(args.output_dir)
    mode = args.mode

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
        print(
            f"[{index:02d}/{len(categories):02d}] Fetching {category['id']} {category['name']} ({mode})",
            flush=True,
        )
        max_rank = 30 if mode == "daily-probe" else (100 if mode == "realtime" else MAX_RANK)
        items, build_at = fetch_category(
            category,
            application_id,
            access_key,
            request_fn,
            sleep_fn=(lambda _seconds: None) if args.fixture else time.sleep,
            max_rank=max_rank,
            period="realtime" if mode == "realtime" else None,
            expected_date=expected_daily_date,
        )
        rankings[str(category["id"])] = items
        source_build_at = source_build_at or build_at

    captured_at = datetime.now(JST).replace(microsecond=0)
    if mode == "realtime":
        update_realtime(output_dir, categories, rankings, captured_at, source_build_at)
        print(f"Saved {sum(map(len, rankings.values()))} realtime rows at {captured_at.isoformat()}")
        return

    update_daily_observations(output_dir, rankings, captured_at, source_build_at)
    if mode == "daily-probe":
        print(f"Saved daily update observation at {captured_at.isoformat()}")
        aggregate_date = source_date(source_build_at)
        if needs_auto_daily_fetch(output_dir, aggregate_date, captured_at.date().isoformat(), categories):
            print(f"New daily aggregate date {aggregate_date}; starting automatic full fetch.", flush=True)
            record_auto_daily_fetch(output_dir, aggregate_date, "running")
            daily_args = argparse.Namespace(**{**vars(args), "mode": "daily"})
            try:
                run(daily_args, expected_daily_date=aggregate_date)
            except Exception as error:
                # The probe itself succeeded: publish the observation/failure status and
                # leave the previous complete snapshot as the retry marker.
                record_auto_daily_fetch(output_dir, aggregate_date, "failed",
                                        error.missing_genres if isinstance(error, DailyCompletenessError) else None)
                print("Automatic full daily fetch failed; keeping the published daily ranking. "
                      "The next successful probe will retry.", file=sys.stderr, flush=True)
            else:
                record_auto_daily_fetch(output_dir, aggregate_date, "succeeded")
                print(f"Automatic full daily fetch completed for {aggregate_date}.", flush=True)
        else:
            print("No unpublished current daily aggregate date; full fetch not needed.")
        return

    aggregate_date = source_date(source_build_at)
    today = captured_at.date().isoformat()
    if expected_daily_date and (aggregate_date != expected_daily_date or aggregate_date != today
                                or not any(rankings.values())):
        raise RuntimeError("Automatic daily fetch did not produce a complete current-day snapshot")
    if not args.fixture and aggregate_date != today:
        print(
            f"Daily API has not rolled over ({aggregate_date or 'unknown'}); "
            "leaving the published daily ranking and history unchanged."
        )
        return

    minimums = daily_minimum_counts(output_dir, aggregate_date)
    missing = [genre for genre, count in minimums.items() if len(rankings.get(genre, [])) < count]
    if missing or not any(rankings.values()):
        if expected_daily_date:
            raise DailyCompletenessError(missing or [str(c["id"]) for c in categories])
        # Let the Windows wrapper commit the failure observation instead of leaving
        # a dirty worktree that would block its next pull/retry.
        record_auto_daily_fetch(output_dir, aggregate_date, "failed",
                                missing or [str(c["id"]) for c in categories])
        print("Daily validation failed; retaining the published ranking. "
              "Saved the failure observation for retry at the next probe.", file=sys.stderr)
        return

    latest_path = output_dir / "latest.json"
    history_path = output_dir / "history.json"
    history = load_json(history_path, {"captures": []})
    history_captures = load_history_captures(output_dir, history)
    annotate_changes(
        rankings,
        previous_daily_ranks(history_captures, captured_at, aggregate_date),
    )
    latest = {
        "generatedAt": captured_at.isoformat(),
        "aggregateDate": aggregate_date,
        "sourceBuildAt": source_build_at,
        "categories": categories,
        "rankings": rankings,
        "collectionVersion": DAILY_COLLECTION_VERSION,
    }
    write_json(
        history_path,
        update_history(output_dir, history_captures, rankings, captured_at, aggregate_date),
    )
    # Publish last: the latest snapshot also serves as the successful-fetch marker.
    write_json(latest_path, latest)
    print(f"Saved {sum(map(len, rankings.values()))} ranking rows at {captured_at.isoformat()}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--categories", default=str(ROOT / "config" / "categories.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "data"))
    parser.add_argument("--fixture", help="Use one local API response fixture instead of the network")
    parser.add_argument(
        "--mode", choices=("daily", "daily-probe", "realtime"), default="daily"
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        run(parse_args(sys.argv[1:]))
    except Exception as exc:  # GitHub Actions should fail loudly without leaking secrets.
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
