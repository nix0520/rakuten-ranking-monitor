import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("assemble_pages", ROOT / "scripts" / "assemble_pages.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PagesBundleTests(unittest.TestCase):
    def test_bundle_keeps_rolling_history_and_only_current_realtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            output = Path(directory) / "site"
            (source / "assets").mkdir(parents=True)
            (source / "data" / "archive" / "ranks").mkdir(parents=True)
            (source / "data" / "realtime").mkdir(parents=True)
            for name in MODULE.ROLLING_DATA_DIRS:
                (source / "data" / name).mkdir(parents=True)
                (source / "data" / name / "2026-10-01.json").write_text("{}", encoding="utf-8")
            (source / "index.html").write_text("ok", encoding="utf-8")
            (source / "assets" / "app.js").write_text("ok", encoding="utf-8")
            for name in MODULE.ROOT_DATA_FILES:
                (source / "data" / name).write_text("{}", encoding="utf-8")
            (source / "data" / "archive" / "index.json").write_text("{}", encoding="utf-8")
            (source / "data" / "archive" / "ranks" / "2026-08-20.json").write_text("old", encoding="utf-8")
            latest = {"generatedAt": "2026-10-02T11:46:00+09:00"}
            (source / "data" / "realtime" / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
            (source / "data" / "realtime" / "2026-10-02.json").write_text("current", encoding="utf-8")
            (source / "data" / "realtime" / "2026-10-01.json").write_text("old", encoding="utf-8")

            MODULE.assemble(source, output)

            self.assertTrue((output / "data" / "history" / "2026-10-01.json").is_file())
            self.assertTrue((output / "data" / "archive" / "index.json").is_file())
            self.assertFalse((output / "data" / "archive" / "ranks" / "2026-08-20.json").exists())
            self.assertTrue((output / "data" / "realtime" / "2026-10-02.json").is_file())
            self.assertFalse((output / "data" / "realtime" / "2026-10-01.json").exists())


if __name__ == "__main__":
    unittest.main()
