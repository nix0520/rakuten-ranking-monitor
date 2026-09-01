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
        items, _ = fetch.fetch_category(self.categories[0], "test", "test", lambda *a, **k: {"Items": [], "_notFound": True}, expected_date=self.today)
        self.assertEqual(items, [])


if __name__ == "__main__":
    unittest.main()
