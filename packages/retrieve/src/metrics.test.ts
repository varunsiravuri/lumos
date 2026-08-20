import assert from "node:assert/strict";
import test from "node:test";

import { summarizeEval, type EvalOutcome } from "./metrics.ts";

function outcome(instanceId: string, bm25: number | null, hybrid: number | null): EvalOutcome {
  return {
    instanceId,
    goldFiles: ["target.ts"],
    bm25,
    graph: null,
    hybrid,
    candidates: 10,
    retrieveMs: 1,
  };
}

test("summarizeEval reports guarded improvements without hidden regressions", () => {
  const summary = summarizeEval([
    outcome("improved", 2, 1),
    outcome("unchanged", 1, 1),
  ]);

  assert.deepEqual(summary.hybridVsBm25, { improved: 1, hurt: 0, tie: 1 });
  assert.match(summary.failureMode, /guarded by explicit quoted identifiers/);
});

test("summarizeEval still reports harmful reorderings", () => {
  const summary = summarizeEval([outcome("hurt", 1, 2)]);

  assert.deepEqual(summary.hurt, ["hurt"]);
  assert.match(summary.failureMode, /When hybrid loses/);
});
