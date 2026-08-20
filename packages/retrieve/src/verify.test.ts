import assert from "node:assert/strict";
import test from "node:test";

import { verifyPatch } from "./verify.ts";

test("verification distinguishes a repository with no tests from missing graph evidence", () => {
  const result = verifyPatch({
    changedFiles: ["src/app.py"],
    ranked: [{
      path: "src/app.py",
      score: 1,
      lexicalScore: 1,
      graphScore: 0.7,
      bm25Rank: 1,
      evidence: [],
      why: [],
    }],
    tests: [],
    graphVerified: true,
    testFilesDetected: 0,
  });

  const testsCheck = result.checks.find((check) => check.id === "tests");
  const evidenceCheck = result.checks.find((check) => check.id === "evidence");
  assert.match(testsCheck?.detail ?? "", /no detected test files/i);
  assert.equal(evidenceCheck?.state, "pass");
});
