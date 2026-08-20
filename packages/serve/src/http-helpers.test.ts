import assert from "node:assert/strict";
import test from "node:test";

import { githubRepository, publicImportError, publicWorkspace } from "./http-helpers.ts";

test("GitHub repository input accepts only public GitHub owner/name forms", () => {
  assert.deepEqual(githubRepository("vercel/ms"), {
    slug: "vercel/ms",
    url: "https://github.com/vercel/ms.git",
  });
  assert.deepEqual(githubRepository("https://github.com/vercel/ms.git"), {
    slug: "vercel/ms",
    url: "https://github.com/vercel/ms.git",
  });
  assert.equal(githubRepository("git@github.com:vercel/ms.git"), null);
  assert.equal(githubRepository("https://example.com/vercel/ms"), null);
});

test("public workspace metadata omits server paths and reports graph readiness", () => {
  const record = {
    slug: "owner/repo",
    label: "owner/repo",
    root: "/secret/server/path",
    source: "github" as const,
    status: "ready" as const,
    files: 0,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const visible = publicWorkspace(record, {
    active: true,
    files: 12,
    graphFiles: 0,
    graphSymbols: 0,
    serviceReady: true,
  });
  assert.equal("root" in visible, false);
  assert.equal(visible.status, "unindexed");
  assert.equal(visible.graphReady, false);
});

test("import errors are stable and do not expose command details", () => {
  assert.equal(publicImportError().includes("git clone"), false);
  assert.equal(publicImportError().includes("/Users/"), false);
});
