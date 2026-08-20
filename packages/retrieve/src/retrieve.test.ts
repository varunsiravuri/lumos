import assert from "node:assert/strict";
import test from "node:test";

import { Edge } from "@lumos/graph";

import { FILE_EDGES, retrievalProof, type RetrieveResult } from "./retrieve.ts";

test("file seeds can traverse imports when co-change history is sparse", () => {
  assert.deepEqual(FILE_EDGES, [Edge.IMPORTS, Edge.CO_CHANGES]);
});

function result(overrides: Partial<RetrieveResult>): RetrieveResult {
  return {
    ranked: [],
    lexical: [],
    structural: [],
    mentions: [],
    seeds: [],
    unresolved: [],
    tests: [],
    traversal: {
      engine: "HydraDB algo.MSpaths",
      direction: "both",
      relTypes: [],
      seedCount: 0,
      pathCount: 0,
      elapsedMs: 0,
    },
    graphOnly: [],
    ...overrides,
  };
}

test("unresolved request names keep unrelated structural expansion text-only", () => {
  const ranked = [{
    path: "src/app.py",
    score: 1,
    lexicalScore: 1,
    graphScore: 0.1,
    bm25Rank: 1,
    evidence: [{ via: "lexical:src/app.py", depth: 1, relTypes: [Edge.IMPORTS], reached: "src/config.py" }],
    why: [],
  }];
  const proof = retrievalProof(result({
    ranked,
    lexical: ranked,
    seeds: [{ ukey: "repo#src/app.py", label: "File", path: "src/app.py", weight: 0.3, via: "lexical:src/app.py" }],
    unresolved: ["ValidationError"],
  }));

  assert.equal(proof.requestMismatch, true);
  assert.equal(proof.mode, "text-only");
});
