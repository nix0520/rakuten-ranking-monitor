"""Resumable daily collection and durable archives. No API credentials are persisted."""
import json
import re
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path


def promotion_evidence(item, captured_at):
    text = unicodedata.normalize("NFKC", " ".join(str(item.get(k) or "") for k in ("itemName", "catchcopy")))
    claims = sorted({int(m) for m in re.findall(r"(?:P|ポイント)\s*(\d{1,2})\s*倍", text, re.I)})
    return {
        "api": {"rate": item.get("pointRate"), "observedAt": captured_at,
                "startAt": item.get("pointRateStartAt") or None, "endAt": item.get("pointRateEndAt") or None},
        "title": [{"rate": rate, "observedAt": captured_at} for rate in claims],
        "page": None,
    }


def archive_expiring(output, cutoff, load, write):
    """Move expired rank/product pairs only after both copies and index are durable."""
    index_path = output / "archive/index.json"
    entries = {e["date"]: e for e in load(index_path, {"captures": []}).get("captures", [])}
    for rank_file in sorted((output / "history").glob("????-??-??.json")):
        day = rank_file.stem
        if day >= cutoff:
            continue
        capture = load(rank_file, {})
        product_file = output / "history-products" / (day + ".json")
        archived_product = None
        if product_file.exists():
            archived_product = f"archive/products/{day}.json"
            write(output / archived_product, load(product_file, {}))
            capture["productsFile"] = archived_product
        archived_rank = f"archive/ranks/{day}.json"
        write(output / archived_rank, capture)
        entries[day] = {"date": day, "capturedAt": capture.get("capturedAt"), "file": archived_rank}
        write(index_path, {"captures": [entries[k] for k in sorted(entries)]})
        rank_file.unlink()
        if archived_product:
            product_file.unlink()


def backfill_analysis(output, load, write):
    """Recover metadata only from each saved day's own product snapshot."""
    for path in (output / "history").glob("????-??-??.json"):
        capture = load(path, {})
        if capture.get("analysisVersion") == 1:
            continue
        products = capture.get("products", {})
        relative = capture.get("productsFile", "")
        if re.fullmatch(r"history-products/\d{4}-\d{2}-\d{2}\.json", relative):
            products = load(output / relative, {}).get("products", {})
        capture["analysisProducts"] = {code:{k:p.get(k) for k in ("itemName", "catchcopy")} for code,p in products.items()}
        for metrics in capture.get("metrics", {}).values():
            for code, metric in metrics.items():
                p = products.get(code, {})
                for key in ("reviewCount", "reviewAverage"):
                    if key not in metric and p.get(key) is not None:
                        metric[key] = p[key]
                if p.get("itemName"):
                    metric.setdefault("pointEvidence", promotion_evidence({**p, "pointRate": metric.get("pointRate")}, capture.get("capturedAt")))
        capture["analysisVersion"] = 1
        write(path, capture)


def collect_daily(categories, output, day, version, fetch_one, source_date, load, write, now, minimums):
    """Retry failed genres, checkpoint healthy genres; never publish partial rankings."""
    cache_path = output.parent / ".ranking-cache" / (output.name + "-daily.json")
    cache = load(cache_path, {})
    if cache.get("day") != day or cache.get("version") != version:
        cache = {"day": day, "version": version, "genres": {}}
    latest = load(output / "latest.json", {})
    previous = latest.get("rankings", {}) if latest.get("aggregateDate", "") < day else {}
    status = {"aggregateDate": day, "startedAt": now().isoformat(), "updatedAt": now().isoformat(),
              "status": "running", "total": len(categories), "completed": 0, "genres": {}}
    status_path = output / "collection-status.json"
    def save():
        status["updatedAt"] = now().isoformat()
        status["completed"] = sum(g["status"] == "complete" for g in status["genres"].values())
        write(status_path, status)
        write(cache_path, cache)
        print(f"Daily progress: {status['completed']}/{status['total']} complete", flush=True)
    rankings, source = {}, None
    for category in categories:
        key = str(category["id"])
        saved = cache["genres"].get(key)
        entry = {"name": category["name"], "status": "running", "attempts": 0}
        status["genres"][key] = entry
        if saved and source_date(saved.get("sourceBuildAt")) == day and len(saved.get("items", [])) >= minimums.get(key, 0):
            rankings[key] = saved["items"]
            source = source or saved["sourceBuildAt"]
            entry.update(status="complete", count=len(saved["items"]), resumed=True,
                         observedAt=saved["observedAt"], warning=saved.get("warning"))
            save()
            continue
        last_signature = None
        for attempt in range(2):
            entry["attempts"] += 1
            save()
            try:
                items, build_at = fetch_one(category)
                if items and source_date(build_at) != day:
                    entry.update(status="waiting", reason="source_day_not_current", sourceDate=source_date(build_at))
                    break
                if len(items) < minimums.get(key, 0):
                    entry.update(status="failed", reason="below_same_day_minimum", count=len(items))
                    continue
                old_count = len(previous.get(key, []))
                anomaly = old_count >= 100 and len(items) < old_count * 0.5
                signature = [(i["itemCode"], i["rank"]) for i in items]
                if anomaly and (last_signature is None or signature != last_signature):
                    last_signature = signature
                    entry.update(status="retrying", reason="count_drop", previousCount=old_count, count=len(items))
                    continue
                warning = "count_drop_confirmed_twice" if anomaly else None
                observed_at = now().isoformat()
                for item in items:
                    item["pointEvidence"] = promotion_evidence(item, observed_at)
                # Empty categories have no source date; they are retained as observed empty.
                build_at = build_at if source_date(build_at) == day else day
                rankings[key] = items
                source = source or build_at
                cache["genres"][key] = {"items": items, "sourceBuildAt": build_at,
                                         "observedAt": observed_at, "warning": warning}
                entry.update(status="complete", count=len(items), observedAt=observed_at,
                             warning=warning, coverage="observed_empty" if not items else "collected")
                entry.pop("reason", None)
                break
            except Exception as error:
                # Store a stable category only; URLs and exception messages can contain credentials.
                entry.update(status="failed", reason="request_or_validation_error", errorType=type(error).__name__)
                if isinstance(getattr(error, "code", None), int):
                    entry["httpStatus"] = error.code
        if entry["status"] == "retrying":
            entry["status"] = "failed"
        save()
    missing = [str(c["id"]) for c in categories if str(c["id"]) not in rankings]
    if not any(rankings.values()):
        missing = [str(c["id"]) for c in categories]
    status.update(status="retry_pending" if missing else "validated", missingGenres=missing)
    current = now()
    next_hour = current.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if next_hour.hour > 23 or next_hour.date() != current.date():
        next_hour = (current + timedelta(days=1)).replace(hour=15, minute=0, second=0, microsecond=0)
    elif next_hour.hour < 15:
        next_hour = next_hour.replace(hour=15)
    status["nextRetryAt"] = next_hour.isoformat() if missing else None
    save()
    return rankings, source, missing, status
