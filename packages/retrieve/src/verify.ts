import type { RankedFile, TestHit } from "./retrieve.ts";

export type VerificationState = "pass" | "review" | "fail";
export type PatchStatus = "ready" | "review" | "blocked";

export interface PatchVerificationCheck {
  id: "patch-target" | "scope" | "tests" | "evidence";
  title: string;
  state: VerificationState;
  detail: string;
}

export interface PatchVerification {
  status: PatchStatus;
  score: number;
  summary: string;
  primaryTarget: string | null;
  changedFiles: string[];
  unexpectedFiles: string[];
  matchedTests: string[];
  missingTests: string[];
  checks: PatchVerificationCheck[];
}

export interface VerifyPatchInput {
  changedFiles: readonly string[];
  testsRun?: readonly string[];
  ranked: readonly RankedFile[];
  tests: readonly TestHit[];
  graphVerified: boolean;
}

function normalize(value: string): string {
  return value.trim().replace(/^\.\//, "").replaceAll("\\", "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function testMatches(run: string, expected: TestHit): boolean {
  const normalized = normalize(run).toLowerCase();
  const qualname = expected.qualname.toLowerCase();
  const path = normalize(expected.path).toLowerCase();
  const finalName = qualname.split(".").at(-1) ?? qualname;
  return normalized === qualname
    || normalized === path
    || normalized.endsWith(` ${qualname}`)
    || normalized.endsWith(`:${qualname}`)
    || normalized.endsWith(` ${path}`)
    || normalized === finalName
    || normalized.endsWith(`.${finalName}`)
    || normalized.endsWith(`::${finalName}`)
    || normalized.endsWith(`/${finalName}`);
}

/**
 * Compare an agent's patch with the context Lumos proved before the edit.
 *
 * This deliberately does not pretend to run tests or inspect a git diff. It
 * answers the narrower, honest question: did the agent touch the graph-backed
 * target, stay inside the investigated scope, and report a connected test?
 */
export function verifyPatch(input: VerifyPatchInput): PatchVerification {
  const changedFiles = unique(input.changedFiles);
  const testsRun = unique(input.testsRun ?? []);
  const primaryTarget = input.ranked[0]?.path ?? null;
  const expectedFiles = new Set(input.ranked.map((file) => normalize(file.path)));
  const primaryChanged = primaryTarget ? changedFiles.includes(normalize(primaryTarget)) : false;
  const unexpectedFiles = changedFiles.filter((file) => !expectedFiles.has(file));
  const relevantTests = input.tests.slice(0, 8);
  const matchedTests = relevantTests
    .filter((test) => testsRun.some((run) => testMatches(run, test)))
    .map((test) => test.qualname);
  const missingTests = input.graphVerified && relevantTests.length > 0 && matchedTests.length === 0
    ? relevantTests.slice(0, 3).map((test) => test.qualname)
    : [];

  const checks: PatchVerificationCheck[] = [
    {
      id: "patch-target",
      title: "Primary target changed",
      state: primaryChanged ? "pass" : "fail",
      detail: primaryChanged
        ? `${primaryTarget} is present in the patch.`
        : changedFiles.length === 0
          ? `No changed files were supplied. Lumos expected ${primaryTarget ?? "a ranked target"}.`
          : `The patch does not include Lumos' first target: ${primaryTarget ?? "none"}.`,
    },
    {
      id: "scope",
      title: "Patch stays inside the proved scope",
      state: unexpectedFiles.length === 0 ? "pass" : "review",
      detail: unexpectedFiles.length === 0
        ? `${changedFiles.length} changed ${changedFiles.length === 1 ? "file is" : "files are"} inside the preflight shortlist.`
        : `${unexpectedFiles.length} changed ${unexpectedFiles.length === 1 ? "file was" : "files were"} not in the preflight: ${unexpectedFiles.join(", ")}.`,
    },
    {
      id: "tests",
      title: "A connected test was reported",
      state: relevantTests.length === 0 ? "review" : matchedTests.length > 0 ? "pass" : "review",
      detail: relevantTests.length === 0
        ? "The graph found no connected test, so this change needs manual test selection."
        : matchedTests.length > 0
          ? `${matchedTests[0]} matches the graph-backed test impact.`
          : `No reported test matches the connected test set. Start with ${relevantTests[0]!.qualname}.`,
    },
    {
      id: "evidence",
      title: "Preflight contains graph evidence",
      state: input.graphVerified ? "pass" : "review",
      detail: input.graphVerified
        ? "The recommendation is backed by a HydraDB relationship path."
        : "This run contains text matches only; Lumos cannot strongly verify the patch scope.",
    },
  ];

  const status: PatchStatus = checks.some((check) => check.state === "fail")
    ? "blocked"
    : checks.some((check) => check.state === "review")
      ? "review"
      : "ready";
  const score = Math.max(
    0,
    100 - checks.reduce((penalty, check) => penalty + (check.state === "fail" ? 45 : check.state === "review" ? 15 : 0), 0),
  );
  const summary = status === "ready"
    ? "The patch matches the graph-backed plan and reports a connected test."
    : status === "blocked"
      ? "The patch missed Lumos' primary target. Return it to the agent before merging."
      : "The patch is plausible, but one or more checks still need a human look.";

  return {
    status,
    score,
    summary,
    primaryTarget,
    changedFiles,
    unexpectedFiles,
    matchedTests,
    missingTests,
    checks,
  };
}
