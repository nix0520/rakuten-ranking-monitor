import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
import fetch_rankings as F
from collection_support import collect_daily, archive_expiring, backfill_analysis, promotion_evidence


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out=Path(self.tmp.name)/"data"
        self.now=datetime(2026,9,6,15,0,tzinfo=F.JST)
        self.categories=[{"id":1,"name":"one"},{"id":2,"name":"two"}]
    def rows(self,n):
        return [{"itemCode":f"s:{i}","rank":i+1,"pointRate":1,"itemName":"P10倍"} for i in range(n)]
    def collect(self,fn,day="2026-09-06",minimums=None):
        return collect_daily(self.categories,self.out,day,2,fn,F.source_date,F.load_json,F.write_json,lambda:self.now,minimums or {})
    def test_resume_only_failed_genre_and_preserve_old_published_day(self):
        calls=[]
        F.write_json(self.out/"latest.json",{"aggregateDate":"2026-09-05","rankings":{"1":self.rows(2)}})
        def first(c):
            calls.append(c["id"])
            if c["id"]==2:raise RuntimeError("secret=do-not-store")
            return self.rows(2),"2026-09-06"
        rows,_,missing,status=self.collect(first)
        self.assertEqual(calls,[1,2,2])
        self.assertEqual(missing,["2"])
        self.assertEqual(status["completed"],1)
        self.assertNotIn("do-not-store",(self.out/"collection-status.json").read_text())
        self.assertEqual(F.load_json(self.out/"latest.json",{})["aggregateDate"],"2026-09-05")
        calls.clear()
        self.collect(lambda c:(calls.append(c["id"]) or self.rows(2),"2026-09-06"))
        self.assertEqual(calls,[2])
        calls.clear()
        self.collect(lambda c:(calls.append(c["id"]) or self.rows(2),"2026-09-07"),day="2026-09-07")
        self.assertEqual(calls,[1,2])
    def test_large_drop_requires_two_matching_responses(self):
        F.write_json(self.out/"latest.json",{"aggregateDate":"2026-09-05","rankings":{"1":self.rows(300)}})
        calls=[]
        _,_,missing,status=self.collect(lambda c:(calls.append(c["id"]) or self.rows(30),"2026-09-06"))
        self.assertEqual(calls,[1,1,2])
        self.assertEqual(missing,[])
        self.assertEqual(status["genres"]["1"]["warning"],"count_drop_confirmed_twice")
    def test_same_day_minimum_blocks_repeated_short_response(self):
        _,_,missing,_=self.collect(lambda c:(self.rows(1),"2026-09-06"),minimums={"1":30})
        self.assertEqual(missing,["1"])
    def test_old_date_never_becomes_cached_current_day(self):
        _,_,missing,status=self.collect(lambda c:(self.rows(2),"2026-09-05"))
        self.assertEqual(missing,["1","2"])
        self.assertEqual(status["status"],"retry_pending")
    def test_archive_keeps_rank_product_pair_and_index_after_retention(self):
        F.write_json(self.out/"history/2026-08-01.json",{"capturedAt":"2026-08-01T15:06:00+09:00","aggregateDate":"2026-08-01","genres":{"1":{"s:1":1}},"productsFile":"history-products/2026-08-01.json"})
        F.write_json(self.out/"history-products/2026-08-01.json",{"products":{"s:1":{"itemName":"Old title"}}})
        archive_expiring(self.out,"2026-08-08",F.load_json,F.write_json)
        archived=F.load_json(self.out/"archive/ranks/2026-08-01.json",{})
        self.assertEqual(archived["productsFile"],"archive/products/2026-08-01.json")
        self.assertTrue((self.out/archived["productsFile"]).exists())
        self.assertEqual(F.load_json(self.out/"archive/index.json",{})["captures"][0]["date"],"2026-08-01")
        self.assertFalse((self.out/"history/2026-08-01.json").exists())
    def test_backfill_uses_only_matching_historical_snapshot(self):
        F.write_json(self.out/"history/2026-09-01.json",{"capturedAt":"2026-09-01T15:00:00+09:00","metrics":{"1":{"s:1":{"pointRate":1}}},"products":{"s:1":{"itemName":"P10倍","reviewCount":200}}})
        F.write_json(self.out/"latest.json",{"rankings":{"1":[{"itemCode":"s:1","reviewCount":999}]}})
        backfill_analysis(self.out,F.load_json,F.write_json)
        m=F.load_json(self.out/"history/2026-09-01.json",{})["metrics"]["1"]["s:1"]
        self.assertEqual(m["reviewCount"],200)
        self.assertEqual(m["pointEvidence"]["api"]["rate"],1)
        self.assertEqual(m["pointEvidence"]["title"][0]["rate"],10)
        self.assertIsNone(m["pointEvidence"]["page"])
    def test_unknown_api_points_do_not_crash_or_create_a_rise(self):
        before={"1":[{"itemCode":"s:1","rank":2,"itemPrice":1000,"pointRate":1}]}
        after={"1":[{"itemCode":"s:1","rank":1,"itemPrice":1000,"pointRate":None}]}
        self.assertFalse(F.promotion_diff(after,before)["1"]["surgeSignals"][0]["pointIncreased"])
