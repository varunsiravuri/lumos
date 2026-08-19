/**
 * Read a repository checkout into a lexical index.
 *
 * The file set has to be identical to the one the extractor walked, or the
 * comparison is rigged: a baseline that cannot see a file it was never given
 * loses for the wrong reason. The skip list here mirrors `tools/extract_python.py`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { Bm25Index } from "./bm25.ts";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".tox", ".nox", ".venv", "venv", "env",
  "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache",
  "build", "dist", ".eggs", "site-packages",
]);

/** Beyond this a file is generated data, a vendored blob or a fixture dump. */
const MAX_BYTES = 1_500_000;

/** Mirrors `is_test_path` in the extractor, so both sides agree on what a test is. */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1]!;
  return (
    base.startsWith("test_") ||
    base.endsWith("_test.py") ||
    parts.slice(0, -1).some((part) => part === "tests" || part === "test" || part === "testing")
  );
}

export interface ListOptions {
  /**
   * Tests are excluded by default because they cannot be the answer: a
   * SWE-bench fix patch never touches one, the test changes ship separately.
   * They remain in the graph and are still walked through — a test is often the
   * only thing linking the file you named to the file you need — they just are
   * not themselves rankable.
   */
  includeTests?: boolean;
}

export function listPythonFiles(root: string, options: ListOptions = {}): string[] {
  const files: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(relative(root, join(directory, entry.name)));
      }
    }
  };

  walk(root);
  return files.filter((path) => options.includeTests || !isTestPath(path)).sort();
}

export interface Corpus {
  files: string[];
  index: Bm25Index;
}

export function buildCorpus(root: string, options: ListOptions = {}): Corpus {
  const files = listPythonFiles(root, options);
  const index = new Bm25Index();

  for (const path of files) {
    const absolute = join(root, path);
    let contents = "";
    try {
      if (statSync(absolute).size <= MAX_BYTES) contents = readFileSync(absolute, "utf8");
    } catch {
      // A path listed but unreadable is still indexed on its name alone.
    }
    index.add(path, contents);
  }

  return { files, index };
}
