import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCorpus, listRepoFiles } from "./corpus.ts";

test("repository discovery excludes Lumos machine data and build output", () => {
  const root = mkdtempSync(join(tmpdir(), "lumos-corpus-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    mkdirSync(join(root, "data", "repos", "nested"), { recursive: true });
    mkdirSync(join(root, ".next", "server"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const live = true;\n");
    writeFileSync(join(root, "tests", "index.test.ts"), "export const covered = true;\n");
    writeFileSync(join(root, "data", "repos", "nested", "foreign.py"), "foreign = True\n");
    writeFileSync(join(root, ".next", "server", "generated.js"), "generated = true;\n");

    assert.deepEqual(listRepoFiles(root), ["src/index.ts"]);
    const corpus = buildCorpus(root);
    assert.deepEqual(corpus.files, ["src/index.ts"]);
    assert.deepEqual(corpus.testFiles, ["tests/index.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
