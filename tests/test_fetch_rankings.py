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
        dictionary_image = fetch.normalize_item({**base, "mediumImageUrls": [{"imageUrl": "https://a"}]})
        string_image = fetch.normalize_item({**base, "mediumImageUrls": ["https://b"]})
        self.assertEqual(dictionary_image["imageUrl"], "https://a")
        self.assertEqual(string_image["imageUrl"], "https://b")
        self.assertEqual(dictionary_image["itemPrice"], 1234)

    def test_fetch_category_returns_only_top_100(self):
        calls = []

        def request(_genre, page, _app, _key):
            calls.append(page)
            start = (page - 1) * 30 + 1
            return {"Items": [{"rank": rank, "itemCode": f"shop:{rank}"} for rank in range(start, start + 30)]}

        items, _ = fetch.fetch_category({"id": 110854}, "app", "key", request)
        self.assertEqual(calls, [1, 2, 3, 4])
        self.assertEqual(len(items), 100)
        self.assertEqual(items[-1]["rank"], 100)

    def test_change_annotation_and_history_retention(self):
        rankings = {"110854": [{"itemCode": "shop:a", "rank": 3}, {"itemCode": "shop:new", "rank": 8}]}
        fetch.annotate_changes(rankings, {"110854": {"shop:a": 7}})
        self.assertEqual(rankings["110854"][0]["change"], 4)
        self.assertTrue(rankings["110854"][1]["isNew"])

        now = datetime(2026, 8, 20, 12, 15, tzinfo=fetch.JST)
        history = {"captures": [
            {"capturedAt": (now - timedelta(days=31)).isoformat(), "genres": {}},
            {"capturedAt": (now - timedelta(days=2)).isoformat(), "genres": {}},
        ]}
        updated = fetch.update_history(history, rankings, now)
        self.assertEqual(len(updated["captures"]), 2)
        self.assertEqual(updated["captures"][-1]["genres"]["110854"]["shop:a"], 3)

    def test_fixture_cli_output_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fetch.parse_args(["--fixture", str(ROOT / "tests" / "fixtures" / "api_page.json"), "--output-dir", directory])
            fetch.run(args)
            latest = json.loads((Path(directory) / "latest.json").read_text(encoding="utf-8"))
            history = json.loads((Path(directory) / "history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(latest["categories"]), 17)
            self.assertEqual(len(latest["rankings"]), 17)
            self.assertEqual(len(history["captures"]), 1)


if __name__ == "__main__":
    unittest.main()
