import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_rankings as fetch


class AutoDailyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.now = datetime.now(fetch.JST).replace(microsecond=0)
        self.today = self.now.date().isoformat()
        self.yesterday = (self.now - timedelta(days=1)).date().isoformat()
        self.categories = fetch.load_json(ROOT / "config/categories.json", [])
        self.old_rows = {str(c["id"]): [self.row(5)] for c in self.categories}
        index = fetch.update_history(self.output, [], self.old_rows, self.now - timedelta(days=1), self.yesterday)
        fetch.write_json(self.output / "history.json", index)
        self.previous = {"generatedAt": (self.now - timedelta(days=1)).isoformat(),
                         "aggregateDate": self.yesterday, "categories": self.categories, "rankings": self.old_rows}
        fetch.write_json(self.output / "latest.json", self.previous)
        self.args = fetch.parse_args(["--mode", "daily-probe", "--fixture", str(ROOT / "tests/fixtures/api_page.json"),
                                      "--output-dir", str(self.output)])
        self.calls = []
        self.full_failure = False
        self.source_day = self.today

    @staticmethod
    def row(rank):
        return {"itemCode": "shop:item", "itemName": "Test", "rank": rank,
                "itemPrice": 1000, "pointRate": 1, "promotionHints": []}

    def request(self, category, *_args, **kwargs):
        self.calls.append(kwargs)
        if kwargs["max_rank"] == fetch.MAX_RANK and self.full_failure:
            raise RuntimeError("secret API response must not be logged")
        return [self.row(2)], self.source_day + "T00:00:00+09:00"

    def run_probe(self):
        with patch.object(fetch, "fetch_category", side_effect=self.request), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fetch.run(self.args)

    def attempts(self):
        log = fetch.load_json(self.output / "daily-update-log.json", {})
        return [o["autoDailyFetch"] for d in log["days"] for o in d["observations"] if "autoDailyFetch" in o]

    def test_new_day_runs_full_17_categories_once_and_uses_yesterday(self):
        self.run_probe()
        self.assertEqual(len(self.calls), 34)
        self.assertEqual([c["max_rank"] for c in self.calls], [30] * 17 + [1000] * 17)
        self.assertTrue(all(c["expected_date"] == self.today for c in self.calls[17:]))
        latest = fetch.load_json(self.output / "latest.json", {})
        self.assertEqual(latest["aggregateDate"], self.today)
        self.assertEqual(len(latest["rankings"]), 17)
        item = latest["rankings"][str(self.categories[0]["id"])][0]
        self.assertEqual(item["change"], 3)
        self.assertEqual(item["previousRank"], 5)
        self.assertEqual(self.attempts()[0]["status"], "succeeded")
        self.run_probe()
        self.assertEqual(len(self.calls), 51)  # only 17 lightweight calls on repeat
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), latest)
        self.assertEqual(len(self.attempts()), 1)

    def test_failure_keeps_old_published_day_and_next_probe_retries(self):
        self.full_failure = True
        self.run_probe()
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)
        self.assertEqual(self.attempts()[0]["status"], "failed")
        self.assertNotIn("secret", (self.output / "daily-update-log.json").read_text())
        self.full_failure = False
        self.run_probe()
        self.assertEqual([a["status"] for a in self.attempts()], ["failed", "succeeded"])
        self.assertEqual(fetch.load_json(self.output / "latest.json", {})["aggregateDate"], self.today)

    def test_old_unknown_future_days_do_not_trigger_full_fetch(self):
        for day in [self.yesterday, "invalid", (self.now + timedelta(days=1)).date().isoformat()]:
            self.source_day = day
            self.run_probe()
        self.assertEqual(len(self.calls), 51)
        self.assertTrue(all(c["max_rank"] == 30 for c in self.calls))
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)

    def test_already_detected_but_unpublished_still_triggers(self):
        fetch.update_daily_observations(self.output, self.old_rows, self.now, self.today)
        self.run_probe()
        self.assertEqual(len(self.calls), 34)
        self.assertEqual(self.attempts()[0]["status"], "succeeded")

    def test_failed_history_write_does_not_mark_day_complete(self):
        with patch.object(fetch, "update_history", side_effect=OSError("disk full")):
            self.run_probe()
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)
        self.assertEqual(self.attempts()[0]["status"], "failed")
        self.run_probe()
        self.assertEqual(self.attempts()[-1]["status"], "succeeded")

    def test_all_empty_full_fetch_is_not_published(self):
        original = self.request
        def empty(category, *args, **kwargs):
            if kwargs["max_rank"] == 1000:
                return [], self.today
            return original(category, *args, **kwargs)
        with patch.object(fetch, "fetch_category", side_effect=empty), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fetch.run(self.args)
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)
        self.assertEqual(self.attempts()[0]["status"], "failed")

    def test_dated_page_validation_rejects_mixed_pages_but_allows_empty_genre(self):
        def mixed(_genre, page, *_args, **_kwargs):
            return {"lastBuildDate": self.today if page == 1 else self.yesterday,
                    "Items": [dict(self.row(i), itemCode=f"shop:{i}") for i in range(1, 31)]}
        with self.assertRaisesRegex(RuntimeError, "date mismatch"):
            fetch.fetch_category(self.categories[0], "test", "test", mixed, sleep_fn=lambda _: None, expected_date=self.today)
        with self.assertRaisesRegex(RuntimeError, "date mismatch"):
            fetch.fetch_category(self.categories[0], "test", "test", lambda *a, **k: {"Items": [self.row(1)]}, expected_date=self.today)
        items, _ = fetch.fetch_category(self.categories[0], "test", "test", lambda *a, **k: {"Items": [], "_notFound": True}, sleep_fn=lambda _: None, expected_date=self.today)
        self.assertEqual(items, [])

    def test_one_genre_empty_after_positive_probe_is_failed_and_retried(self):
        genre = str(self.categories[0]["id"])
        original = self.request
        def missing(category, *args, **kwargs):
            if str(category["id"]) == genre and kwargs["max_rank"] == 1000:
                return [], self.today
            return original(category, *args, **kwargs)
        with patch.object(fetch, "fetch_category", side_effect=missing), contextlib.redirect_stdout(io.StringIO()):
            fetch.run(self.args)
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)
        self.assertEqual(self.attempts()[0]["status"], "failed")
        self.assertEqual(self.attempts()[0]["missingGenres"], [genre])
        self.assertFalse((self.output / f"history/{self.today}.json").exists())
        self.run_probe()
        self.assertEqual(self.attempts()[-1]["status"], "succeeded")

    def test_already_published_empty_genre_is_not_a_success_marker(self):
        genre = str(self.categories[0]["id"])
        broken = {**self.previous, "aggregateDate": self.today, "collectionVersion": 2,
                  "rankings": {**self.old_rows, genre: []}}
        fetch.write_json(self.output / "latest.json", broken)
        fetch.update_daily_observations(self.output, self.old_rows, self.now, self.today)
        self.assertTrue(fetch.needs_auto_daily_fetch(self.output, self.today, self.today, self.categories))
        self.run_probe()
        latest = fetch.load_json(self.output / "latest.json", {})
        self.assertEqual(len(latest["rankings"][genre]), 1)
        self.assertEqual(latest["rankings"][genre][0]["previousRank"], 5)
        self.assertFalse(fetch.needs_auto_daily_fetch(self.output, self.today, self.today, self.categories))

    def test_legacy_current_day_is_refetched_once_for_pagination_fix(self):
        fetch.write_json(self.output / "latest.json", {**self.previous, "aggregateDate": self.today})
        self.run_probe()
        self.assertEqual(len(self.calls), 34)
        self.run_probe()
        self.assertEqual(len(self.calls), 51)

    def test_consistently_empty_current_day_does_not_copy_yesterday(self):
        genre = str(self.categories[0]["id"])
        original = self.request
        def empty(category, *args, **kwargs):
            if str(category["id"]) == genre:
                return [], self.today
            return original(category, *args, **kwargs)
        with patch.object(fetch, "fetch_category", side_effect=empty), contextlib.redirect_stdout(io.StringIO()):
            fetch.run(self.args)
        latest = fetch.load_json(self.output / "latest.json", {})
        self.assertEqual(latest["aggregateDate"], self.today)
        self.assertEqual(latest["rankings"][genre], [])
        self.assertEqual(self.attempts()[-1]["status"], "succeeded")

    def test_manual_full_fetch_also_rejects_below_observed_minimum(self):
        genre = str(self.categories[0]["id"])
        rows = {genre: [dict(self.row(i), itemCode=f"shop:{i}") for i in range(1, 31)]}
        fetch.update_daily_observations(self.output, rows, self.now, self.today)
        # A subsequent empty observation must not erase the positive evidence.
        fetch.update_daily_observations(self.output, {genre: []}, self.now, self.today)
        self.args.mode = "daily"
        self.run_probe()
        self.assertEqual(fetch.load_json(self.output / "latest.json", {}), self.previous)
        self.assertEqual(self.attempts()[-1]["missingGenres"], [genre])

    def test_short_page_does_not_terminate_full_daily_pagination(self):
        calls = []
        def request(_genre, page, *_args, **_kwargs):
            calls.append(page)
            ranks = range(1, 30) if page == 1 else range(31, 61) if page == 2 else []
            return {"Items": [dict(self.row(i), itemCode=f"shop:{i}") for i in ranks], "lastBuildDate": self.today}
        items, _ = fetch.fetch_category(self.categories[0], "a", "k", request,
                                       sleep_fn=lambda _: None, expected_date=self.today)
        self.assertEqual(len(items), 59)
        self.assertEqual(items[-1]["rank"], 60)
        self.assertEqual(calls, [1, 2, 3, 3, 3])

    def test_transient_empty_first_page_retries_and_recovers(self):
        attempts = []
        def request(_genre, page, *_args, **_kwargs):
            attempts.append(page)
            if len(attempts) == 1:
                return {"Items": [], "_notFound": True}
            return {"Items": [self.row(1)] if page == 1 else [], "lastBuildDate": self.today}
        items, _ = fetch.fetch_category(self.categories[0], "a", "k", request,
                                       sleep_fn=lambda _: None, expected_date=self.today)
        self.assertEqual(len(items), 1)
        self.assertEqual(attempts[:2], [1, 1])

    def test_repeated_page_is_not_accepted_as_complete(self):
        with self.assertRaisesRegex(RuntimeError, "no valid progress"):
            fetch.fetch_category(self.categories[0], "a", "k",
                lambda *a, **k: {"Items": [self.row(1)], "lastBuildDate": self.today},
                sleep_fn=lambda _: None, expected_date=self.today)


if __name__ == "__main__":
    unittest.main()
