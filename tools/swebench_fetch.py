#!/usr/bin/env python3
"""Fetch SWE-bench instances and derive the ground truth for file retrieval.

Each instance is a real GitHub issue plus the patch that actually resolved it.
The files touched by that patch are the answer key: a retriever that surfaces
them from the issue text alone has found what a developer would have had to
find by reading the codebase.

Only the gold *files* are kept, not the diff hunks. Ranking files is the part a
coding assistant has to get right before it can write anything, and it is the
part that is scoreable without executing a single test.

Emits JSONL:

    {"instance_id": ..., "repo": ..., "base_commit": ..., "problem": ...,
     "gold_files": [...], "created_at": ..., "version": ...}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROWS_URL = "https://datasets-server.huggingface.co/rows"
PAGE_SIZE = 100


def fetch_page(dataset: str, split: str, offset: int, length: int) -> dict:
    query = urllib.parse.urlencode({
        "dataset": dataset,
        "config": "default",
        "split": split,
        "offset": offset,
        "length": length,
    })
    request = urllib.request.Request(
        f"{ROWS_URL}?{query}",
        headers={"User-Agent": "lumos-swebench-fetch"},
    )

    # The datasets server warms a cache on first access and answers 500 until it
    # is ready, so a cold dataset needs a retry rather than a failure.
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            if attempt == 4:
                raise
            print(f"  retrying after {error}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))

    raise RuntimeError("unreachable")


def gold_files(patch: str) -> list[str]:
    """Repository-relative paths modified by a unified diff.

    Read from the `+++ b/` side so that a file the patch creates is still
    credited, and fall back to the `--- a/` side for deletions.
    """
    files: list[str] = []
    seen: set[str] = set()
    previous_old = ""

    for line in patch.splitlines():
        if line.startswith("--- "):
            previous_old = line[4:].strip()
        elif line.startswith("+++ "):
            path = line[4:].strip()
            if path == "/dev/null":
                path = previous_old
            for prefix in ("a/", "b/"):
                if path.startswith(prefix):
                    path = path[len(prefix):]
            if path and path != "/dev/null" and path not in seen:
                seen.add(path)
                files.append(path)

    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="test")
    parser.add_argument("--repo", default="", help='keep only this repo, e.g. "django/django"')
    parser.add_argument("--limit", type=int, default=0, help="stop after N kept instances")
    parser.add_argument("--python-only", action="store_true",
                        help="drop instances whose patch touches no .py file")
    args = parser.parse_args()

    first = fetch_page(args.dataset, args.split, 0, 1)
    total = first["num_rows_total"]
    print(f"{args.dataset}:{args.split} has {total} instances", file=sys.stderr)

    out = sys.stdout
    kept = 0
    repos: dict[str, int] = {}

    for offset in range(0, total, PAGE_SIZE):
        page = fetch_page(args.dataset, args.split, offset, min(PAGE_SIZE, total - offset))

        for entry in page["rows"]:
            row = entry["row"]
            repos[row["repo"]] = repos.get(row["repo"], 0) + 1

            if args.repo and row["repo"] != args.repo:
                continue

            files = gold_files(row["patch"])
            if args.python_only and not any(f.endswith(".py") for f in files):
                continue
            if not files:
                continue

            out.write(json.dumps({
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
                "problem": row["problem_statement"],
                "gold_files": files,
                "created_at": row["created_at"],
                "version": row["version"],
            }, separators=(",", ":")))
            out.write("\n")

            kept += 1
            if args.limit and kept >= args.limit:
                print(f"kept {kept} instances", file=sys.stderr)
                return 0

        print(f"  {min(offset + PAGE_SIZE, total)}/{total}", file=sys.stderr)

    print(f"kept {kept} instances", file=sys.stderr)
    for repo, count in sorted(repos.items(), key=lambda item: -item[1]):
        print(f"  {count:5d}  {repo}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
