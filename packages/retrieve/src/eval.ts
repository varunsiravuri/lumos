/**
 * Score Lumos against BM25 on SWE-bench, one real issue at a time.
 *
 * The measurement is deliberately unforgiving. Each instance is evaluated at
 * its own `base_commit`: the repository is checked out at the commit the bug
 * was reported against, the graph is rebuilt from that tree, and the lexical
 * index is built from the same files. Nothing from the future leaks in, and
 * neither retriever sees a file the other cannot.
 *
 * The answer key is the file the merged fix actually touched. SWE-bench Lite
 * has exactly one per instance, and never a test file — the tests live in a
 * separate patch — so the question is simply: how far down the list is it.
 *
 *   pnpm eval data/swebench/lite.jsonl --repo django/django --root data/repos/django
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { HydraClient } from "@lumos/graph";

import { buildCorpus } from "./corpus.ts";
import { summarizeEval, type EvalOutcome } from "./metrics.ts";
import { retrieve } from "./retrieve.ts";

const CUTOFFS = [1, 3, 5, 10, 20];

/** Ranking depth kept per instance so every method can be scored from one run. */
const DEPTH = 200;

interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem: string;
  gold_files: string[];
}

type Outcome = EvalOutcome;

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Everything a child process said before it died, not just the exit line. */
function describe(error: unknown): string {
  const failure = error as { message?: string; stdout?: string; stderr?: string };
  return [
    failure.message ?? String(error),
    "\n--- stdout ---\n",
    failure.stdout ?? "",
    "\n--- stderr ---\n",
    failure.stderr ?? "",
  ].join("");
}

/** First position of any gold file in a ranking, 1-based. */
function rankOf(ranking: string[], gold: string[]): number | null {
  const wanted = new Set(gold);
  const found = ranking.findIndex((path) => wanted.has(path));
  return found === -1 ? null : found + 1;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    root: { type: "string" },
    limit: { type: "string", default: "0" },
    skip: { type: "string", default: "0" },
    "max-commits": { type: "string", default: "3000" },
    "reset-every": { type: "string", default: "6" },
    workdir: { type: "string", default: "data/eval" },
    out: { type: "string", default: "data/eval/django-hybrid.jsonl" },
    rebuild: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
  },
});

if (positionals.length === 0 || !values.repo || !values.root) {
  console.error("usage: pnpm eval <instances.jsonl> --repo <slug> --root <checkout> [--limit n] [--rebuild]");
  process.exit(1);
}

const root = values.root!;
const workdir = values.workdir!;
const outPath = values.out!;
mkdirSync(workdir, { recursive: true });

const all: Instance[] = readFileSync(positionals[0]!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Instance)
  .filter((instance) => instance.repo === values.repo);

const skip = Number(values.skip);
const limit = Number(values.limit);
const instances = all.slice(skip, limit ? skip + limit : undefined);

const client = new HydraClient();
if (!(await client.ready())) {
  console.error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  process.exit(1);
}

const manifestPath = join(workdir, "ingested.json");
const resume = (values.resume || (existsSync(outPath) && !values.fresh)) && existsSync(outPath);

process.stdout.write("resetting HydraDB so every remaining snapshot is measured on a clean store\n");
run("bash", ["scripts/db-reset.sh"]);

const manifest: Record<string, true> = {};
writeFileSync(manifestPath, "{}");

const outcomes: Outcome[] = resume
  ? readFileSync(outPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Outcome)
  : [];
const already = new Set(outcomes.map((row) => row.instanceId));
if (already.size > 0) {
  console.log(`resuming: ${already.size} instances already scored, will not rerank them`);
}
const failures: string[] = [];
const startedAll = Date.now();
const resetEvery = Number(values["reset-every"]);
let sinceReset = 0;

console.log(`${instances.length} instances from ${values.repo}\n`);

for (const [position, instance] of instances.entries()) {
  const short = instance.base_commit.slice(0, 12);
  // The slug carries the commit, so each snapshot is its own namespace and
  // nothing connects two of them.
  const slug = `${instance.repo}@${short}`;
  const prefix = join(workdir, `${instance.instance_id}`);

  process.stdout.write(`[${position + 1}/${instances.length}] ${instance.instance_id} `);

  if (already.has(instance.instance_id)) {
    console.log("cached");
    continue;
  }

  // Snapshots are independent, so keeping them is pure cost. Left to
  // accumulate, ingestion slows until a batch write trips the 30s query
  // timeout — at sixteen Django snapshots the store was already 6 GB. Emptying
  // it periodically also keeps every measurement taken against a graph the
  // size a single repository actually produces.
  if (resetEvery > 0 && sinceReset >= resetEvery) {
    process.stdout.write("reset ");
    run("bash", ["scripts/db-reset.sh"]);
    for (const key of Object.keys(manifest)) delete manifest[key];
    sinceReset = 0;
  }

  try {
    run("git", ["-C", root, "checkout", "--quiet", "--force", "--detach", instance.base_commit]);
    run("git", ["-C", root, "clean", "-qfdx"]);
  } catch (error) {
    console.log(`skipped (checkout failed: ${(error as Error).message.split("\n")[0]})`);
    failures.push(instance.instance_id);
    continue;
  }

  if (values.rebuild || !manifest[slug]) {
    if (values.rebuild || !existsSync(`${prefix}.jsonl`)) {
      process.stdout.write("extract ");
      writeFileSync(
        `${prefix}.jsonl`,
        run("python3", ["tools/extract_python.py", root, "--slug", slug, "--commit", instance.base_commit]),
      );
    }

    if (values.rebuild || !existsSync(`${prefix}.cochange.jsonl`)) {
      process.stdout.write("cochange ");
      writeFileSync(
        `${prefix}.cochange.jsonl`,
        run("python3", ["tools/mine_cochange.py", root, "--max-commits", values["max-commits"]!]),
      );
    }

    // Ingestion is the one step that fails for reasons unrelated to the data:
    // a batch write that lands during compaction. Emptying the store and
    // retrying clears it. A snapshot that fails twice is a real defect and is
    // recorded rather than quietly dropped, because an excluded instance is a
    // thumb on the scale.
    let ingested = false;

    for (let attempt = 1; attempt <= 2 && !ingested; attempt += 1) {
      try {
        process.stdout.write(attempt === 1 ? "ingest " : "ingest-retry ");
        run("node", [
          "--no-warnings",
          "--import", "tsx",
          "--env-file-if-exists=.env",
          "packages/ingest/src/cli.ts",
          `${prefix}.jsonl`,
          `${prefix}.cochange.jsonl`,
        ]);
        ingested = true;
      } catch (error) {
        writeFileSync(`${prefix}.err`, describe(error));
        if (attempt === 2) break;
        run("bash", ["scripts/db-reset.sh"]);
        for (const key of Object.keys(manifest)) delete manifest[key];
        sinceReset = 0;
      }
    }

    if (!ingested) {
      console.log(`FAILED (see ${prefix}.err)`);
      failures.push(instance.instance_id);
      sinceReset += 1;
      continue;
    }

    manifest[slug] = true;
    sinceReset += 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  process.stdout.write("rank ");
  const corpus = buildCorpus(root);
  const startedRetrieve = Date.now();

  let result;
  try {
    result = await retrieve(client, corpus.index, instance.problem, {
      repo: slug,
      files: corpus.files,
      testFiles: corpus.testFiles,
      limit: DEPTH,
      lexicalSeedCount: 0,
    });
  } catch (error) {
    console.log(`FAILED rank (${String((error as Error).message).split("\n")[0] ?? "unknown"})`);
    failures.push(instance.instance_id);
    continue;
  }

  const retrieveMs = Date.now() - startedRetrieve;

  const outcome: Outcome = {
    instanceId: instance.instance_id,
    goldFiles: instance.gold_files,
    bm25: rankOf(result.lexical.map((file) => file.path), instance.gold_files),
    graph: rankOf(result.structural.map((file) => file.path), instance.gold_files),
    hybrid: rankOf(result.ranked.map((file) => file.path), instance.gold_files),
    candidates: corpus.files.length,
    retrieveMs,
  };

  outcomes.push(outcome);
  already.add(outcome.instanceId);
  writeFileSync(outPath, outcomes.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(workdir, "summary.json"), JSON.stringify(summarizeEval(outcomes), null, 2));

  console.log(
    `bm25 ${outcome.bm25 ?? "—"}  graph ${outcome.graph ?? "—"}  hybrid ${outcome.hybrid ?? "—"}  (${retrieveMs}ms)`,
  );
}

writeFileSync(outPath, outcomes.map((outcome) => JSON.stringify(outcome)).join("\n") + "\n");
const summary = summarizeEval(outcomes);
writeFileSync(join(workdir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\n${outcomes.length} instances in ${((Date.now() - startedAll) / 1000).toFixed(0)}s\n`);
console.log(`  ${"".padEnd(14)}${CUTOFFS.map((k) => `@${k}`.padStart(7)).join("")}${"MRR".padStart(9)}`);

const pct = (value: number) => `${(value * 100).toFixed(1)}%`.padStart(7);
for (const label of ["bm25", "graph", "hybrid"] as const) {
  const metrics = summary.methods[label];
  const columns = [metrics.at1, metrics.at3, metrics.at5, metrics.at10, metrics.at20].map(pct).join("");
  console.log(`  ${label.padEnd(14)}${columns}${metrics.mrr.toFixed(3).padStart(9)}`);
}

console.log(
  `\n  hybrid vs bm25   improved ${summary.hybridVsBm25.improved}, hurt ${summary.hybridVsBm25.hurt}, tie ${summary.hybridVsBm25.tie}`,
);
console.log(`  ${summary.failureMode}`);

const median = [...outcomes].map((o) => o.retrieveMs).sort((a, b) => a - b)[Math.floor(outcomes.length / 2)];
console.log(`\n  median retrieval ${median}ms over ${outcomes[0]?.candidates.toLocaleString() ?? 0} candidate files`);

if (failures.length > 0) {
  console.log(`  ${failures.length} instances failed to build and are excluded: ${failures.join(", ")}`);
}

console.log(`  results written to ${values.out}`);
