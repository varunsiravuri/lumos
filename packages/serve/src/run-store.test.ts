import assert from "node:assert/strict";
import test from "node:test";

import { scopeEvents, scopeRuns, type LumosEvent, type StoredRun } from "./run-store.ts";

const quality: StoredRun["quality"] = {
  filesChecked: 1,
  filesSelected: 1,
  graphEvidenceFiles: 1,
  testsFound: 0,
  mode: "graph-verified",
};

function run(id: string, repo: string): StoredRun {
  return {
    id,
    repo,
    request: "Change one behavior",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "complete",
    elapsedMs: 1,
    result: {},
    trace: [],
    quality,
  };
}

test("runs and current events stay scoped to the active repository", () => {
  const runs = [run("run-a", "owner/a"), run("run-b", "owner/b")];
  const events: LumosEvent[] = [
    { id: "a", at: "2026-01-01", source: "workspace", tool: "preflight", state: "complete", summary: "a", runId: "run-a" },
    { id: "b", at: "2026-01-01", source: "mcp", tool: "preflight", state: "complete", summary: "b", repo: "owner/b" },
  ];
  assert.deepEqual(scopeRuns(runs, "owner/a").map((item) => item.id), ["run-a"]);
  assert.deepEqual(scopeEvents(events, "owner/a", runs).map((item) => item.id), ["a"]);
});
