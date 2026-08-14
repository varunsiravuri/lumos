#!/usr/bin/env python3
"""Mine co-change coupling from a repository's git history.

Two files that keep being revised in the same commit are coupled, even when
nothing in the source connects them: a parser and its golden fixtures, a model
and the migration that shadows it, an interface and the one implementation that
always has to follow. That coupling is invisible to an import graph and
invisible to an embedding, and it is exactly what a reviewer means by "you
probably also need to touch this".

Emits JSONL on stdout:

    {"t": "cochange", "src": <path>, "dst": <path>, "commits": n, "strength": f}

Edges are canonical and single-directional — `src` sorts before `dst` — because
co-change is symmetric. Traverse them with `relDirection: 'both'` rather than
writing each pair twice, which would double every path through the graph.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from itertools import combinations

# A commit touching hundreds of files is a reformat, a licence header sweep or a
# dependency bump. It says nothing about coupling and would otherwise dominate
# every count, so wide commits are dropped rather than down-weighted.
DEFAULT_MAX_FILES = 30


def read_commits(repo: str, max_commits: int) -> tuple[list[list[str]], int]:
    """Return the Python files touched by each recent non-merge commit.

    Paths are rewritten to the names the files carry today. Without this, a
    repository that has moved to a `src/` layout produces history full of
    `requests/models.py` while the graph contains `src/requests/models.py`, and
    every co-change edge dangles.

    History is walked newest-first, so a rename seen at one commit tells us how
    to rewrite every older mention of the old name.
    """
    result = subprocess.run(
        [
            "git", "-C", repo, "log",
            "--no-merges",
            f"--max-count={max_commits}",
            "--name-status",
            "-M",
            "--pretty=format:%x00",
            "--diff-filter=ACMR",
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    renames: dict[str, str] = {}
    commits: list[list[str]] = []
    rewritten = 0

    for block in result.stdout.split("\x00"):
        touched: list[str] = []
        pending: list[tuple[str, str]] = []

        for line in block.splitlines():
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[0].startswith("R"):
                old, new = parts[1], parts[2]
                pending.append((old, new))
                touched.append(new)
            elif len(parts) == 2:
                touched.append(parts[1])

        resolved = set()
        for path in touched:
            current = renames.get(path, path)
            if current != path:
                rewritten += 1
            if current.endswith(".py"):
                resolved.add(current)

        if resolved:
            commits.append(sorted(resolved))

        # Register this commit's renames for the older commits still to come.
        for old, new in pending:
            renames[old] = renames.get(new, new)

    return commits, rewritten


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", help="repository root")
    parser.add_argument("--max-commits", type=int, default=3000)
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES,
                        help="skip commits touching more files than this")
    parser.add_argument("--min-commits", type=int, default=3,
                        help="minimum shared commits before a pair becomes an edge")
    args = parser.parse_args()

    commits, rewritten = read_commits(args.repo, args.max_commits)

    # Only files still present can become edges, since nothing else has a node.
    live = {
        path for path in {p for commit in commits for p in commit}
        if os.path.exists(os.path.join(args.repo, path))
    }
    commits = [[p for p in commit if p in live] for commit in commits]

    touches: Counter[str] = Counter()
    pairs: Counter[tuple[str, str]] = Counter()
    considered = 0

    for files in commits:
        if len(files) < 2 or len(files) > args.max_files:
            continue
        considered += 1
        for path in files:
            touches[path] += 1
        for a, b in combinations(files, 2):
            pairs[(a, b)] += 1

    out = sys.stdout
    emitted = 0

    for (a, b), shared in pairs.items():
        if shared < args.min_commits:
            continue
        # Normalising by the rarer of the two files keeps the score meaningful
        # when one file changes constantly and the other almost never does.
        denominator = min(touches[a], touches[b])
        strength = shared / denominator if denominator else 0.0
        out.write(json.dumps({
            "t": "cochange",
            "src": a,
            "dst": b,
            "commits": shared,
            "strength": round(strength, 4),
        }, separators=(",", ":")))
        out.write("\n")
        emitted += 1

    out.write(json.dumps({
        "t": "cochange_stats",
        "commits_read": len(commits),
        "commits_considered": considered,
        "paths_rewritten_by_rename": rewritten,
        "live_files": len(live),
        "candidate_pairs": len(pairs),
        "edges": emitted,
    }, separators=(",", ":")))
    out.write("\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
