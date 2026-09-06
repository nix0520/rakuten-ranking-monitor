"""Run the dependency-free frontend tests with the existing CI test command."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is needed for frontend tests")
class FrontendTests(unittest.TestCase):
    def test_frontend_logic_and_syntax(self):
        subprocess.run(["node", "--input-type=module", "--check"], input=(ROOT / "assets/app.js").read_text(), text=True, cwd=ROOT, check=True)
        subprocess.run(["node", "--test", "tests/test_insights.mjs", "tests/test_app.mjs", "tests/test_history_tools.mjs", "tests/test_analysis.mjs"], cwd=ROOT, check=True)
