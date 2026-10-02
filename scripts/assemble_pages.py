#!/usr/bin/env python3
"""Build a bounded GitHub Pages bundle without deleting repository history."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path


ROOT_DATA_FILES = (
    "latest.json",
    "history.json",
    "daily-update-log.json",
    "collection-status.json",
    "publication.json",
)
ROLLING_DATA_DIRS = ("history", "history-products", "history-trends")
MAX_PAGES_BYTES = 900 * 1024 * 1024


def copy_required(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"required Pages file is missing: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_optional_tree(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target)


def tree_bytes(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def assemble(source: Path, output: Path) -> int:
    source = source.resolve()
    output = output.resolve()
    if output == source or source in output.parents and output.name == "data":
        raise ValueError("output must not replace the repository or source data")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    copy_required(source / "index.html", output / "index.html")
    copy_optional_tree(source / "assets", output / "assets")
    data_output = output / "data"
    data_output.mkdir()

    for name in ROOT_DATA_FILES:
        copy_required(source / "data" / name, data_output / name)
    for name in ROLLING_DATA_DIRS:
        copy_optional_tree(source / "data" / name, data_output / name)

    archive_index = source / "data" / "archive" / "index.json"
    if archive_index.is_file():
        copy_required(archive_index, data_output / "archive" / "index.json")

    realtime_latest = source / "data" / "realtime" / "latest.json"
    copy_required(realtime_latest, data_output / "realtime" / "latest.json")
    realtime = json.loads(realtime_latest.read_text(encoding="utf-8"))
    generated_at = str(realtime.get("generatedAt") or "")
    realtime_day = generated_at[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", realtime_day):
        raise ValueError("realtime/latest.json has no valid generatedAt day")
    copy_required(
        source / "data" / "realtime" / f"{realtime_day}.json",
        data_output / "realtime" / f"{realtime_day}.json",
    )

    (output / ".nojekyll").touch()
    size = tree_bytes(output)
    if size > MAX_PAGES_BYTES:
        raise RuntimeError(
            f"Pages bundle is {size / 1024 / 1024:.1f} MiB; refusing to approach the 1 GiB limit"
        )
    print(
        f"Pages bundle: {size / 1024 / 1024:.1f} MiB; "
        "repository archives retained, old realtime files excluded"
    )
    return size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, default=Path("_site"))
    args = parser.parse_args()
    assemble(args.source, args.output)


if __name__ == "__main__":
    main()
