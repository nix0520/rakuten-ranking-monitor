import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_rankings as fetch  # noqa: E402


class RankingTests(unittest.TestCase):
    def test_daily_history_stores_metrics_without_backfilling_legacy_prices(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            legacy = {"capturedAt": "2026-08-30T20:30:00+09:00", "aggregateDate": "2026-08-30", "genres": {"1": {"a": 5}}}
            rankings = {"1": [{"itemCode": "a", "rank": 2, "itemPrice": 1200, "pointRate": 5, "promotionHints": ["sale"]}]}
            moment = datetime.fromisoformat("2026-08-31T20:30:00+09:00")
            index = fetch.update_history(output, [legacy], rankings, moment, "2026-08-31")
            captures = fetch.load_history_captures(output, index)
            self.assertNotIn("metrics", captures[0])
            self.assertEqual(captures[1]["metrics"]["1"]["a"]["itemPrice"], 1200)
            self.assertEqual(captures[1]["metrics"]["1"]["a"]["pointRate"], 5)
            self.assertNotIn("products", captures[1])
            self.assertEqual(captures[1]["productsFile"], "history-products/2026-08-31.json")
            products = json.loads((output / captures[1]["productsFile"]).read_text())
            self.assertIn("a", products["products"])
            rankings["1"][0]["itemPrice"] = 900
            fetch.update_history(output, captures, rankings, moment, "2026-08-31")
            saved = json.loads((output / "history/2026-08-31.json").read_text())
            self.assertEqual(saved["metrics"]["1"]["a"]["itemPrice"], 900)
            self.assertEqual(fetch.previous_daily_ranks(captures, moment, "2026-08-31")["1"]["a"], 5)

    def test_product_snapshots_follow_history_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            rows = {"1": [{"itemCode": "shop:a", "rank": 2, "itemName": "Historical name", "itemPrice": 1000}]}
            moment = datetime.fromisoformat("2026-08-01T20:30:00+09:00")
            index = fetch.update_history(output, [], rows, moment, "2026-08-01")
            old = output / "history-products/2026-08-01.json"
            self.assertEqual(json.loads(old.read_text())["products"]["shop:a"]["itemName"], "Historical name")
            captures = fetch.load_history_captures(output, index)
            fetch.update_history(output, captures, rows, moment + timedelta(days=31), "2026-09-01")
            self.assertFalse(old.exists())
            self.assertTrue((output / "history-products/2026-09-01.json").exists())

    def test_api_request_treats_404_as_an_empty_ranking_page(self):
        def opener(request, timeout):
            raise fetch.urllib.error.HTTPError(
                request.full_url,
                404,
                "Not Found",
                {},
                BytesIO(b'{"statusCode":404,"message":"Resource not found"}'),
            )

        payload = fetch.api_request(100433, 1, "app-id", "access-key", opener, attempts=1)

        self.assertEqual(payload, {"Items": [], "_notFound": True})

    def test_api_request_still_fails_for_authentication_errors(self):
        def opener(request, timeout):
            raise fetch.urllib.error.HTTPError(
                request.full_url,
                403,
                "Forbidden",
                {},
                BytesIO(b'{"errorMessage":"Invalid Access Key"}'),
            )

        with self.assertRaisesRegex(RuntimeError, "Invalid Access Key"):
            fetch.api_request(110854, 1, "app-id", "bad-key", opener, attempts=1)

    def test_api_request_sends_access_key_as_query_parameter(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"Items": []}'

        def opener(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = request.headers
            captured["timeout"] = timeout
            return Response()

        payload = fetch.api_request(110854, 1, "app-id", "access-key", opener, attempts=1)
        query = fetch.urllib.parse.parse_qs(fetch.urllib.parse.urlparse(captured["url"]).query)

        self.assertEqual(payload, {"Items": []})
        self.assertEqual(query["applicationId"], ["app-id"])
        self.assertEqual(query["accessKey"], ["access-key"])
        self.assertNotIn("period", query)
        self.assertNotIn("Accesskey", captured["headers"])
        self.assertEqual(captured["timeout"], 30)

    def test_jst_falls_back_without_system_tzdata(self):
        def missing_zone(_key):
            raise fetch.ZoneInfoNotFoundError("missing tzdata")

        fallback = fetch.load_jst(missing_zone)
        self.assertEqual(fallback.utcoffset(None), timedelta(hours=9))
        self.assertEqual(fallback.tzname(None), "JST")

    def test_category_configuration_is_exactly_17_unique_ids(self):
        categories = json.loads((ROOT / "config" / "categories.json").read_text(encoding="utf-8"))
        fetch.validate_categories(categories)
        self.assertEqual(len(categories), 17)
        self.assertEqual({item["group"] for item in categories}, {"bra", "shorts"})
        self.assertEqual(
            [item["id"] for item in categories if item["group"] == "bra"],
            [110854, 100442, 100433, 566228, 206742, 206725, 566018, 303662, 101817],
        )
        self.assertEqual(
            [item["id"] for item in categories if item["group"] == "shorts"],
            [110845, 206712, 206713, 206714, 566230, 206716, 206717, 100443],
        )

    def test_normalize_supports_both_image_shapes(self):
        base = {"rank": "1", "itemCode": "shop:item", "itemPrice": "1234.0"}
        dictionary_image = fetch.normalize_item({**base, "mediumImageUrls": [{"imageUrl": "https://a"}], "pointRate": 5, "catchcopy": "10%OFFクーポン"})
        string_image = fetch.normalize_item({**base, "mediumImageUrls": ["https://b"]})
        self.assertEqual(dictionary_image["imageUrl"], "https://a")
        self.assertEqual(string_image["imageUrl"], "https://b")
        self.assertEqual(dictionary_image["itemPrice"], 1234)
        self.assertEqual(dictionary_image["pointRate"], 5)
        self.assertTrue(dictionary_image["couponMentioned"])
        self.assertIn("10%OFFクーポン", dictionary_image["promotionHints"])

    def test_coupon_hints_keep_discount_amount_and_normalize_full_width_text(self):
        base = {"rank": 1, "itemCode": "shop:item", "itemPrice": 3590}
        percent = fetch.normalize_item({
            **base, "itemName": "【9/4 20時～】２０％ＯＦＦクーポン対象",
            "catchcopy": "ポイント10倍",
        })
        fixed = fetch.normalize_item({
            **base, "itemName": "500円OFFクーポン配布中",
            "catchcopy": "クーポン利用で￥3,090円",
        })
        unknown = fetch.normalize_item({**base, "itemName": "クーポン対象"})
        self.assertIn("20%OFFクーポン", percent["promotionHints"])
        self.assertIn("ポイント10倍", percent["promotionHints"])
        self.assertIn("500円OFFクーポン", fixed["promotionHints"])
        self.assertIn("クーポン利用で¥3,090円", fixed["promotionHints"])
        self.assertEqual(unknown["promotionHints"][0], "クーポン（割引額不明）")

    def test_fetch_category_returns_up_to_top_1000(self):
        calls = []

        def request(_genre, page, _app, _key, **_kwargs):
            calls.append(page)
            start = (page - 1) * 30 + 1
            return {"Items": [{"rank": rank, "itemCode": f"shop:{rank}"} for rank in range(start, start + 30)]}

        items, _ = fetch.fetch_category(
            {"id": 110854}, "app", "key", request, sleep_fn=lambda _seconds: None
        )
        self.assertEqual(calls, list(range(1, 35)))
        self.assertEqual(len(items), 1000)
        self.assertEqual(items[-1]["rank"], 1000)

    def test_change_annotation_uses_previous_day(self):
        rankings = {"110854": [{"itemCode": "shop:a", "rank": 3}, {"itemCode": "shop:new", "rank": 8}]}
        now = datetime(2026, 8, 20, 12, 15, tzinfo=fetch.JST)
        captures = [
            {"capturedAt": (now - timedelta(days=1)).isoformat(), "genres": {"110854": {"shop:a": 7}}},
            {"capturedAt": now.replace(hour=8).isoformat(), "genres": {"110854": {"shop:a": 1}}},
        ]
        fetch.annotate_changes(rankings, fetch.previous_daily_ranks(captures, now))
        self.assertEqual(rankings["110854"][0]["change"], 4)
        self.assertTrue(rankings["110854"][1]["isNew"])

    def test_previous_daily_ranks_uses_aggregate_date_not_capture_day(self):
        current = datetime(2026, 8, 30, 20, 30, tzinfo=fetch.JST)
        captures = [
            {
                "capturedAt": current.replace(hour=10).isoformat(),
                "aggregateDate": "2026-08-29",
                "genres": {"110854": {"shop:a": 7}},
            },
            {
                "capturedAt": current.replace(hour=19).isoformat(),
                "aggregateDate": "2026-08-30",
                "genres": {"110854": {"shop:a": 2}},
            },
        ]
        previous = fetch.previous_daily_ranks(
            captures, current, aggregate_date="2026-08-30"
        )
        self.assertEqual(previous["110854"]["shop:a"], 7)

    def test_history_is_partitioned_by_date_and_retained_for_30_days(self):
        now = datetime(2026, 8, 20, 12, 15, tzinfo=fetch.JST)
        captures = [
            {"capturedAt": (now - timedelta(days=31)).isoformat(), "genres": {}},
            {"capturedAt": (now - timedelta(days=2)).isoformat(), "genres": {"110854": {"shop:a": 7}}},
        ]
        rankings = {"110854": [{"itemCode": "shop:a", "rank": 3}]}
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            updated = fetch.update_history(
                output_dir, captures, rankings, now, now.date().isoformat()
            )
            self.assertEqual(len(updated["captures"]), 2)
            self.assertEqual(updated["captures"][-1]["file"], "history/2026-08-20.json")
            current = json.loads((output_dir / "history" / "2026-08-20.json").read_text(encoding="utf-8"))
            self.assertEqual(current["genres"]["110854"]["shop:a"], 3)
            self.assertFalse((output_dir / "history" / "2026-07-20.json").exists())

    def test_fixture_cli_output_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fetch.parse_args(["--fixture", str(ROOT / "tests" / "fixtures" / "api_page.json"), "--output-dir", directory])
            fetch.run(args)
            latest = json.loads((Path(directory) / "latest.json").read_text(encoding="utf-8"))
            history = json.loads((Path(directory) / "history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(latest["categories"]), 17)
            self.assertEqual(len(latest["rankings"]), 17)
            self.assertEqual(len(history["captures"]), 1)
            history_file = Path(directory) / history["captures"][0]["file"]
            self.assertTrue(history_file.exists())
            self.assertTrue((Path(directory) / "daily-update-log.json").exists())

    def test_realtime_request_uses_period_and_top_100(self):
        calls = []

        def request(_genre, page, _app, _key, **kwargs):
            calls.append((page, kwargs.get("period")))
            start = (page - 1) * 30 + 1
            return {"Items": [{"rank": rank, "itemCode": f"shop:{rank}"} for rank in range(start, start + 30)]}

        items, _ = fetch.fetch_category(
            {"id": 110854}, "app", "key", request, sleep_fn=lambda _seconds: None,
            max_rank=100, period="realtime",
        )
        self.assertEqual(calls, [(1, "realtime"), (2, "realtime"), (3, "realtime"), (4, "realtime")])
        self.assertEqual(len(items), 100)

    def test_source_date_parses_rakuten_rfc2822_timestamp(self):
        self.assertEqual(
            fetch.source_date("Wed, 26 Aug 2026 00:00:00 +0900"),
            "2026-08-26",
        )

    def test_rank_change_alone_does_not_mark_daily_rollover(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            first = datetime(2026, 8, 27, 9, 50, tzinfo=fetch.JST)
            fetch.update_daily_observations(
                output,
                {"110854": [{"itemCode": "a", "rank": 2}]},
                first,
                "Wed, 26 Aug 2026 00:00:00 +0900",
            )
            fetch.update_daily_observations(
                output,
                {"110854": [{"itemCode": "a", "rank": 1}]},
                first.replace(hour=10, minute=0),
                "Wed, 26 Aug 2026 00:00:00 +0900",
            )
            log = json.loads((output / "daily-update-log.json").read_text(encoding="utf-8"))
            self.assertIsNone(log["days"][0]["firstUpdateDetectedAt"])
            self.assertEqual(log["days"][0]["aggregateDate"], "2026-08-26")

    def test_daily_observation_detects_first_change_once(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            first = datetime(2026, 8, 25, 9, 50, tzinfo=fetch.JST)
            fetch.update_daily_observations(output, {"110854": [{"itemCode": "a", "rank": 2}]}, first, "2026-08-24T10:00:00+09:00")
            fetch.update_daily_observations(output, {"110854": [{"itemCode": "a", "rank": 1}]}, first.replace(minute=0, hour=10), "2026-08-25T10:00:00+09:00")
            fetch.update_daily_observations(output, {"110854": [{"itemCode": "a", "rank": 1}]}, first.replace(minute=10, hour=10), "2026-08-25T10:00:00+09:00")
            log = json.loads((output / "daily-update-log.json").read_text(encoding="utf-8"))
            self.assertEqual(log["days"][0]["firstUpdateDetectedAt"], "2026-08-25T10:00:00+09:00")
            observations = log["days"][0]["observations"]
            self.assertTrue(observations[1]["dailyRollover"])
            self.assertEqual(
                observations[1]["changes"]["110854"]["moved"][0]["change"], 1
            )
            self.assertFalse(observations[2]["dailyRollover"])
            self.assertEqual(observations[2]["changes"], {})

    def test_realtime_latest_contains_previous_interval_change(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            when = datetime(2026, 8, 25, 10, 0, tzinfo=fetch.JST)
            categories = [{"id": 110854, "group": "bra"}]
            fetch.update_realtime(output, categories, {"110854": [{"itemCode": "a", "rank": 5, "itemPrice": 1000, "pointRate": 1}]}, when, "2026-08-25T10:00:00+09:00")
            initial = json.loads((output / "realtime/latest.json").read_text())
            self.assertIsNone(initial["previousCapturedAt"])
            self.assertIsNone(initial["rankings"]["110854"][0]["priceChange"])
            fetch.update_realtime(output, categories, {"110854": [{"itemCode": "a", "rank": 2, "itemPrice": 900, "pointRate": 5}]}, when + timedelta(minutes=20), "2026-08-25T10:20:00+09:00")
            latest = json.loads((output / "realtime" / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["rankings"]["110854"][0]["change"], 3)
            self.assertFalse(latest["rankings"]["110854"][0]["isNew"])
            self.assertEqual(latest["previousCapturedAt"], when.isoformat())
            self.assertEqual(latest["rankings"]["110854"][0]["previousPrice"], 1000)
            self.assertEqual(latest["rankings"]["110854"][0]["priceChange"], -100)
            self.assertEqual(latest["rankings"]["110854"][0]["pointChange"], 4)

    def test_realtime_mode_includes_all_17_genres(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fetch.parse_args([
                "--fixture", str(ROOT / "tests" / "fixtures" / "api_page.json"),
                "--output-dir", directory,
                "--mode", "realtime",
            ])
            fetch.run(args)
            latest = json.loads((Path(directory) / "realtime" / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(len(latest["categories"]), 17)
            self.assertEqual(len(latest["rankings"]), 17)


if __name__ == "__main__":
    unittest.main()
