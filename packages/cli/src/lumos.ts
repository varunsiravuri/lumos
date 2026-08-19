/**
 * The assistant-facing interface. An IDE calls this before it edits.
 *
 *   lumos index /path/to/repo
 *   lumos ask "Changing set_cookie breaks tests"
 *   lumos impact django.http.response.HttpResponse.set_cookie
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { HydraClient } from "@lumos/graph";
import { buildCorpus, impact, retrieve, verifyPatch } from "@lumos/retrieve";

import { DEFAULT_REPO, DEFAULT_ROOT, lumosHome } from "./defaults.ts";

const USAGE = `lumos — structural context for AI coders

  lumos index <repo-path> [--slug owner/name]
  lumos preflight <issue text | - >
  lumos ask <issue text | - >       alias for preflight
  lumos verify <issue text> --changed file[,file] [--tests test[,test]]
  lumos impact <symbol>
  lumos tests <symbol>

Word search guesses. Lumos traces impact.
`;

const [command, ...rest] = process.argv.slice(2);

function flag(name: string, fallback?: string): string | undefined {
  const index = rest.indexOf(name);
  if (index === -1) return fallback;
  return rest[index + 1] ?? fallback;
}

function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function run(commandName: string, args: string[], cwd?: string): string {
  return execFileSync(commandName, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

async function requireClient(): Promise<HydraClient> {
  const client = new HydraClient();
  if (!(await client.ready())) {
    console.error("HydraDB is not ready. Run: pnpm db:up");
    process.exit(1);
  }
  return client;
}

function inferSlug(root: string, explicit?: string): string {
  if (explicit) return explicit;
  try {
    const remote = run("git", ["-C", root, "remote", "get-url", "origin"]).trim();
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  } catch {
    // not a git checkout, or no origin
  }
  return `local/${basename(root)}`;
}

async function cmdIndex(): Promise<void> {
  const target = positionals()[0];
  if (!target) {
    console.error("usage: lumos index <repo-path> [--slug owner/name]");
    process.exit(1);
  }
  const root = resolve(target);
  const home = lumosHome();
  const slug = inferSlug(root, flag("--slug"));
  let commit = "";
  try {
    commit = run("git", ["-C", root, "rev-parse", "HEAD"]).trim();
  } catch {
    commit = "";
  }
  const extractDir = join(home, "data/extract");
  mkdirSync(extractDir, { recursive: true });
  const stem = slug.replaceAll("/", "-");
  const jsonl = join(extractDir, `${stem}.jsonl`);
  const cochange = join(extractDir, `${stem}.cochange.jsonl`);

  console.log(`extract ${slug} @ ${commit.slice(0, 12) || "uncommitted"}`);
  writeFileSync(jsonl, run("python3", [join(home, "tools/extract_python.py"), root, "--slug", slug, "--commit", commit], home));
  console.log(`cochange`);
  writeFileSync(cochange, run("python3", [join(home, "tools/mine_cochange.py"), root, "--max-commits", "3000"], home));
  console.log(`ingest`);
  run(
    "node",
    ["--no-warnings", "--import", "tsx", "--env-file-if-exists=.env", "packages/ingest/src/cli.ts", jsonl, cochange],
    home,
  );
  console.log(`\nindexed ${slug}. Ask with: lumos ask "…"`);
}

async function cmdPreflight(): Promise<void> {
  const raw = positionals().filter((token) => token !== "-").join(" ").trim();
  let issue = raw;
  if (raw === "" || rest.includes("-")) {
    issue = await readStdin();
  }
  if (!issue.trim()) {
    console.error("usage: lumos preflight \"<bug report>\"   or   lumos preflight -");
    process.exit(1);
  }

  const repo = flag("--repo", DEFAULT_REPO)!;
  const root = flag("--root", DEFAULT_ROOT)!;
  const client = await requireClient();
  const corpus = buildCorpus(root);
  const started = Date.now();
  const result = await retrieve(client, corpus.index, issue, {
    repo,
    files: corpus.files,
    limit: Number(flag("--limit", "12")),
  });

  console.log(`\n${result.traversal.engine}  ${result.traversal.elapsedMs}ms  ${result.traversal.pathCount} paths  ${result.seeds.length} seeds`);
  console.log("\nfiles to edit:");
  for (const [index, file] of result.ranked.entries()) {
    const bm25 = file.bm25Rank ? `bm25 #${file.bm25Rank}` : "bm25 miss";
    console.log(`  ${String(index + 1).padStart(2)}. ${file.path}  (${bm25})`);
    for (const line of file.why) console.log(`      ${line}`);
  }
  if (result.tests.length > 0) {
    console.log("\ntests likely to fail:");
    for (const test of result.tests.slice(0, 10)) {
      console.log(`  ${test.qualname}  (${test.path})`);
    }
  }
  console.log(`\n${Date.now() - started}ms including BM25`);
}

async function cmdVerify(): Promise<void> {
  const issue = positionals().join(" ").trim();
  const changedFiles = (flag("--changed") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const testsRun = (flag("--tests") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!issue || changedFiles.length === 0) {
    console.error("usage: lumos verify \"<issue>\" --changed file[,file] [--tests test[,test]]");
    process.exit(1);
  }

  const repo = flag("--repo", DEFAULT_REPO)!;
  const root = flag("--root", DEFAULT_ROOT)!;
  const client = await requireClient();
  const corpus = buildCorpus(root);
  const result = await retrieve(client, corpus.index, issue, {
    repo,
    files: corpus.files,
    limit: Number(flag("--limit", "12")),
  });
  const verification = verifyPatch({
    changedFiles,
    testsRun,
    ranked: result.ranked,
    tests: result.tests,
    graphVerified: result.ranked.some((file) => file.evidence.length > 0),
  });

  console.log(`\n${verification.status.toUpperCase()}  score ${verification.score}/100`);
  console.log(verification.summary);
  for (const check of verification.checks) {
    const mark = check.state === "pass" ? "✓" : check.state === "fail" ? "!" : "?";
    console.log(`  ${mark} ${check.title}`);
    console.log(`    ${check.detail}`);
  }
  if (verification.status === "blocked") process.exitCode = 2;
}

async function cmdImpact(kind: "impact" | "tests"): Promise<void> {
  const symbol = positionals().join(" ").trim();
  if (!symbol) {
    console.error(`usage: lumos ${kind} <symbol>`);
    process.exit(1);
  }
  const repo = flag("--repo", DEFAULT_REPO)!;
  const client = await requireClient();
  const result = await impact(client, { repo, symbol, maxHops: Number(flag("--hops", "4")) });
  if (!result) {
    console.error(`no symbol matching ${JSON.stringify(symbol)} in ${repo}`);
    process.exit(2);
  }
  console.log(`\n${result.seed.qualname}`);
  console.log(`  ${result.seed.path}`);
  console.log(`  HydraDB algo.MSpaths incoming CALLS+COVERS  depth ${flag("--hops", "4")}  ${result.elapsedMs}ms`);
  console.log(`  ${result.symbols.length} callers  ${result.tests.length} tests  ${result.pathCount} paths`);
  if (kind === "tests") {
    for (const hit of result.tests.slice(0, 30)) console.log(`  ${hit.qualname}`);
    return;
  }
  console.log("\ncallers:");
  for (const hit of result.symbols.slice(0, 25)) {
    console.log(`  d${hit.depth}  ${hit.qualname}`);
  }
  if (result.tests.length > 0) {
    console.log("\ntests:");
    for (const hit of result.tests.slice(0, 15)) console.log(`  d${hit.depth}  ${hit.qualname}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

switch (command) {
  case "index":
    await cmdIndex();
    break;
  case "ask":
  case "preflight":
    await cmdPreflight();
    break;
  case "verify":
    await cmdVerify();
    break;
  case "impact":
    await cmdImpact("impact");
    break;
  case "tests":
    await cmdImpact("tests");
    break;
  default:
    console.error(USAGE);
    process.exit(command ? 1 : 0);
}
