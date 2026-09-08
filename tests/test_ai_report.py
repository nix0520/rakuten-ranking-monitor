import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('report', Path(__file__).resolve().parents[1] / 'scripts/generate_ai_report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.old = {'aggregateDate': '2026-09-06', 'genres': {'a': {'x': 42}}, 'metrics': {'a': {'x': {'itemPrice': 100, 'pointRate': 1, 'promotionHints': [], 'reviewCount': 100}}}}
        self.now = {'aggregateDate': '2026-09-07', 'genres': {'a': {'x': 8}}, 'metrics': {'a': {'x': {'itemPrice': 90, 'pointRate': 10, 'promotionHints': ['10%OFF'], 'reviewCount': 151}}}}

    def test_changes_and_input_not_mutated(self):
        original = copy.deepcopy(self.now)
        result = report.compare(self.now, self.old)
        row = result['importantChanges'][0]
        self.assertEqual(row['rankChange'], 34)
        self.assertEqual(row['priceChangePercent'], -10)
        self.assertEqual(row['reviewChange'], 51)
        self.assertIn('相对昨日进入TOP20', row['facts'])
        self.assertIn('优惠原文变化', row['facts'])
        self.assertEqual(self.now, original)
        self.assertFalse(result['modelUsed'])

    def test_gap_never_compares_previous_saved_day(self):
        self.old['aggregateDate'] = '2026-09-05'
        result = report.compare(self.now, self.old)
        self.assertEqual(result['status'], 'missing_yesterday')
        self.assertEqual(result['importantChanges'], [])

    def test_missing_metrics_do_not_become_zero(self):
        self.now['metrics'] = {}
        row = report.compare(self.now, self.old)['importantChanges'][0]
        self.assertIsNone(row['priceChangePercent'])
        self.assertIsNone(row['today']['reviewCount'])
        self.assertNotIn('优惠原文变化', row['facts'])

    def test_empty_genre_not_exit(self):
        self.now['genres']['a'] = {}
        self.assertEqual(report.compare(self.now, self.old)['importantChanges'], [])

    def test_truncated_capture_not_exit(self):
        self.old['genres']['a'] = {'x': 8, 'y': 1}
        self.now['genres']['a'] = {'y': 1}
        self.assertEqual(report.compare(self.now, self.old)['importantChanges'], [])

    def test_deduplicate_products_across_genres(self):
        self.now['genres']['b'] = {'x': 8}
        self.old['genres']['b'] = {'x': 42}
        result = report.compare(self.now, self.old)
        self.assertEqual(result['summary']['trackedProducts'], 1)
        self.assertEqual(result['summary']['affectedProducts'], 1)
        self.assertEqual(result['summary']['eventRows'], 2)
