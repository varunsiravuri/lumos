/**
 * HTTP surface for the demo. HydraDB stays on the other side of this process;
 * the browser never talks to it directly.
 *
 *   pnpm api
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { HydraClient, Label } from "@lumos/graph";
import {
  buildCorpus,
  impact,
  retrieve,
  summarizeEval,
  verifyPatch,
  type Corpus,
  type EvalOutcome,
} from "@lumos/retrieve";

import { absoluteRepoRoot, writeCursorConnect } from "@lumos/cli/connect";
import { lumosHome } from "@lumos/cli/defaults";

import {
  appendEvent,
  createRunId,
  getRun,
  listEvents,
  listRuns,
  saveRun,
  type RunTraceStep,
} from "./run-store.ts";
import { WorkspaceStore, workspaceLabel, type WorkspaceRecord } from "./workspace-store.ts";

const PORT = Number(process.env.LUMOS_API_PORT ?? 8787);
const DEFAULT_REPO = process.env.LUMOS_REPO ?? "django/django";
const DEFAULT_ROOT = resolve(process.env.LUMOS_ROOT ?? "data/repos/django");
const KILLER_ID = "django__django-16873";
const LITE_PATH = "data/swebench/lite.jsonl";
const EVAL_SUMMARY = "data/eval/summary.json";
const EVAL_RESULTS = "data/eval/django-hybrid.jsonl";
const IMPORT_ROOT = resolve(process.env.LUMOS_IMPORT_ROOT ?? "data/repos/imports");
const WORKSPACE_STORE = process.env.LUMOS_WORKSPACE_STORE ?? "data/workspaces.json";
const execFileAsync = promisify(execFile);

const WITHOUT_HYDRA = [
  "no reverse call chain",
  "no test impact",
  "no transitive blast radius",
  "only lexical similarity",
];

const client = new HydraClient();
const corpusByRoot = new Map<string, Corpus>();
let corpusError: string | null = null;

const now = new Date().toISOString();
const workspaces = new WorkspaceStore(WORKSPACE_STORE, {
  slug: DEFAULT_REPO,
  label: workspaceLabel(DEFAULT_REPO),
  root: DEFAULT_ROOT,
  source: DEFAULT_REPO === "django/django" ? "sample" : "local",
  status: "ready",
  files: 0,
  addedAt: now,
  updatedAt: now,
});

type ImportStatus = "queued" | "cloning" | "indexing" | "ready" | "error";
interface ImportJob {
  id: string;
  slug: string;
  url: string;
  status: ImportStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

const importJobs = new Map<string, ImportJob>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function loadCorpus(workspace = workspaces.active()): Corpus {
  const key = resolve(workspace.root);
  const cached = corpusByRoot.get(key);
  if (cached) return cached;
  const loaded = buildCorpus(key);
  corpusByRoot.set(key, loaded);
  return loaded;
}

function githubRepository(value: string): { slug: string; url: string } | null {
  const trimmed = value.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  const full = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  const match = full ?? shorthand;
  if (!match?.[1] || !match[2]) return null;
  const slug = `${match[1]}/${match[2]}`;
  return { slug, url: `https://github.com/${slug}.git` };
}

function updateImportJob(id: string, update: Partial<ImportJob>): ImportJob {
  const current = importJobs.get(id);
  if (!current) throw new Error(`import job ${id} was not found`);
  const next: ImportJob = { ...current, ...update, updatedAt: new Date().toISOString() };
  importJobs.set(id, next);
  return next;
}

async function runImport(job: ImportJob): Promise<void> {
  const destination = join(IMPORT_ROOT, job.slug.replaceAll("/", "--"));
  const timestamp = new Date().toISOString();
  workspaces.upsert({
    slug: job.slug,
    label: workspaceLabel(job.slug),
    root: destination,
    source: "github",
    status: "indexing",
    files: 0,
    addedAt: workspaces.get(job.slug)?.addedAt ?? timestamp,
    updatedAt: timestamp,
    url: job.url.replace(/\.git$/, ""),
  });

  try {
    mkdirSync(IMPORT_ROOT, { recursive: true });
    updateImportJob(job.id, { status: "cloning", message: "Cloning the public repository" });
    if (existsSync(join(destination, ".git"))) {
      await execFileAsync("git", ["-C", destination, "fetch", "--depth", "300", "origin"], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60_000,
      });
      await execFileAsync("git", ["-C", destination, "reset", "--hard", "FETCH_HEAD"], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      });
    } else {
      await execFileAsync("git", ["clone", "--depth", "300", job.url, destination], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60_000,
      });
    }

    updateImportJob(job.id, { status: "indexing", message: "Extracting symbols and building HydraDB paths" });
    await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        "--env-file-if-exists=.env",
        "packages/cli/src/lumos.ts",
        "index",
        destination,
        "--slug",
        job.slug,
        "--lang",
        "auto",
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 512 * 1024 * 1024,
        timeout: 20 * 60_000,
      },
    );

    corpusByRoot.delete(resolve(destination));
    const files = loadCorpus({ ...workspaces.get(job.slug)!, root: destination }).files.length;
    workspaces.upsert({
      slug: job.slug,
      label: workspaceLabel(job.slug),
      root: destination,
      source: "github",
      status: "ready",
      files,
      addedAt: workspaces.get(job.slug)?.addedAt ?? timestamp,
      updatedAt: new Date().toISOString(),
      url: job.url.replace(/\.git$/, ""),
    });
    workspaces.activate(job.slug);
    updateImportJob(job.id, { status: "ready", message: `${files.toLocaleString("en-US")} files indexed and ready` });
    appendEvent({
      source: "workspace",
      tool: "lumos.import_repository",
      state: "complete",
      summary: `${job.slug}: ${files.toLocaleString("en-US")} files indexed`,
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.split("\n")[0] ?? reason.message : "Repository import failed";
    updateImportJob(job.id, { status: "error", message: "Repository import failed", error: message });
    workspaces.upsert({
      slug: job.slug,
      label: workspaceLabel(job.slug),
      root: destination,
      source: "github",
      status: "error",
      files: 0,
      addedAt: workspaces.get(job.slug)?.addedAt ?? timestamp,
      updatedAt: new Date().toISOString(),
      url: job.url.replace(/\.git$/, ""),
      error: message,
    });
  }
}

function loadKiller(): {
  id: string;
  issue: string;
  gold: string[];
  note: string;
} | null {
  if (!existsSync(LITE_PATH)) return null;
  for (const line of readFileSync(LITE_PATH, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { instance_id: string; problem: string; gold_files: string[] };
    if (row.instance_id !== KILLER_ID) continue;
    return {
      id: row.instance_id,
      issue: row.problem,
      gold: row.gold_files,
      note: "Word search ranks defaultfilters.py third. Lumos seeds the quoted join filter, walks CALLS/COVERS, and puts the patched file first.",
    };
  }
  return null;
}

function loadEval() {
  if (existsSync(EVAL_SUMMARY)) {
    return JSON.parse(readFileSync(EVAL_SUMMARY, "utf8")) as unknown;
  }
  if (!existsSync(EVAL_RESULTS)) return null;
  const outcomes = readFileSync(EVAL_RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalOutcome);
  return summarizeEval(outcomes);
}

function loadEvalOutcomes(): EvalOutcome[] {
  if (!existsSync(EVAL_RESULTS)) return [];
  return readFileSync(EVAL_RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalOutcome);
}

function languageSummary(files: string[]): { language: string; files: number }[] {
  const labels: Record<string, string> = {
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
  };
  const counts = new Map<string, number>();
  for (const path of files) {
    const label = labels[extname(path).toLowerCase()] ?? "Other";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, files: count }))
    .sort((left, right) => right.files - left.files);
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const ready = await client.ready();
      json(res, ready ? 200 : 503, { ready, repo: workspaces.active().slug });
      return;
    }

    if (req.method === "GET" && url.pathname === "/meta") {
      const ready = await client.ready();
      const active = workspaces.active();
      const files = ready && active.status === "ready" ? loadCorpus(active).files.length : active.files;
      json(res, ready ? 200 : 503, {
        ready,
        repo: active.slug,
        label: active.label,
        sample: active.source === "sample",
        source: active.source,
        root: active.root,
        workspace: process.cwd(),
        files,
        workspaces: workspaces.list().length,
        engine: "HydraDB algo.MSpaths",
        product: "Lumos preflight and verification for coding agents",
        runs: listRuns(500).length,
        capabilities: ["preflight", "graph proof", "agent handoff", "patch guard"],
        mcpTools: [
          "lumos.preflight_change",
          "lumos.verify_patch",
          "lumos.explain_file_rank",
          "lumos.impact",
          "lumos.tests_for_change",
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/repositories") {
      const active = workspaces.active();
      json(res, 200, {
        active: active.slug,
        repositories: workspaces.list().map((record) => ({
          ...record,
          active: record.slug === active.slug,
        })),
        imports: [...importJobs.values()].slice(-10).reverse(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/repositories/activate") {
      const body = JSON.parse((await readBody(req)) || "{}") as { slug?: string };
      if (!body.slug) {
        json(res, 400, { error: "slug is required" });
        return;
      }
      const active = workspaces.activate(body.slug);
      if (!active) {
        json(res, 409, { error: "repository is not ready to activate" });
        return;
      }
      json(res, 200, { repository: active });
      return;
    }

    if (req.method === "POST" && url.pathname === "/repositories/import") {
      if (!(await client.ready())) {
        json(res, 503, { error: "HydraDB must be ready before importing a repository" });
        return;
      }
      if ([...importJobs.values()].some((job) => ["queued", "cloning", "indexing"].includes(job.status))) {
        json(res, 409, { error: "Another repository is currently being indexed. Wait for it to finish." });
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}") as { url?: string };
      const parsed = githubRepository(body.url ?? "");
      if (!parsed) {
        json(res, 422, { error: "Enter a public GitHub repository as owner/name or https://github.com/owner/name" });
        return;
      }
      const existing = workspaces.get(parsed.slug);
      if (existing?.status === "ready" && existsSync(existing.root)) {
        workspaces.activate(existing.slug);
        json(res, 200, { repository: existing, reused: true });
        return;
      }
      const startedAt = new Date().toISOString();
      const job: ImportJob = {
        id: randomUUID().slice(0, 12),
        slug: parsed.slug,
        url: parsed.url,
        status: "queued",
        message: "Import queued",
        startedAt,
        updatedAt: startedAt,
      };
      importJobs.set(job.id, job);
      void runImport(job);
      json(res, 202, { job });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/repositories/import/")) {
      const id = decodeURIComponent(url.pathname.slice("/repositories/import/".length));
      const job = importJobs.get(id);
      if (!job) {
        json(res, 404, { error: "import job not found" });
        return;
      }
      json(res, 200, { job, repository: workspaces.get(job.slug) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/files") {
      const active = workspaces.active();
      const files = loadCorpus(active).files;
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 160)));
      const matches = query ? files.filter((path) => path.toLowerCase().includes(query)) : files;
      json(res, 200, {
        repo: active.slug,
        total: files.length,
        matched: matches.length,
        languages: languageSummary(files),
        files: matches.slice(0, limit),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/file") {
      const active = workspaces.active();
      const path = url.searchParams.get("path") ?? "";
      const corpus = loadCorpus(active);
      if (!path || !corpus.files.includes(path)) {
        json(res, 404, { error: "indexed file not found" });
        return;
      }
      const root = resolve(active.root);
      const absolute = resolve(root, path);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
        json(res, 400, { error: "invalid repository path" });
        return;
      }
      const source = readFileSync(absolute, "utf8");
      json(res, 200, {
        repo: active.slug,
        path,
        truncated: source.length > 200_000,
        content: source.slice(0, 200_000),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30)));
      json(res, 200, {
        runs: listRuns(limit).map((run) => ({
          id: run.id,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          status: run.status,
          request: run.request,
          repo: run.repo,
          elapsedMs: run.elapsedMs,
          quality: run.quality,
        })),
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/runs/".length));
      const run = getRun(id);
      if (!run) {
        json(res, 404, { error: "run not found" });
        return;
      }
      json(res, 200, run);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30)));
      json(res, 200, { events: listEvents(limit) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/connect") {
      const body = JSON.parse((await readBody(req)) || "{}") as { targetRoot?: string };
      const home = lumosHome();
      const active = workspaces.active();
      const indexedRoot = absoluteRepoRoot(active.root, home);
      const fallback = active.source === "sample" ? home : indexedRoot;
      const written = writeCursorConnect({
        targetRoot: body.targetRoot?.trim() || fallback,
        lumosHome: home,
        repo: active.slug,
        indexedRoot,
      });
      json(res, 200, written);
      return;
    }

    if (req.method === "POST" && url.pathname === "/verify") {
      const body = JSON.parse(await readBody(req)) as {
        runId?: string;
        changedFiles?: string[];
        testsRun?: string[];
      };
      if (!body.runId) {
        json(res, 400, { error: "runId is required" });
        return;
      }
      const run = getRun(body.runId);
      if (!run) {
        json(res, 404, { error: "run not found. Run a preflight before verifying the patch." });
        return;
      }
      const result = run.result as {
        ranked: Parameters<typeof verifyPatch>[0]["ranked"];
        tests: Parameters<typeof verifyPatch>[0]["tests"];
      };
      const verification = verifyPatch({
        changedFiles: body.changedFiles ?? [],
        testsRun: body.testsRun ?? [],
        ranked: result.ranked,
        tests: result.tests,
        graphVerified: run.quality.mode !== "text-only",
      });
      appendEvent({
        source: "workspace",
        tool: "lumos.verify_patch",
        state: "complete",
        summary: `${verification.status}: ${verification.changedFiles.length} changed files, ${verification.matchedTests.length} connected tests`,
        runId: run.id,
      });
      json(res, 200, { runId: run.id, verifiedAt: new Date().toISOString(), ...verification });
      return;
    }

    if (req.method === "GET" && url.pathname === "/demo") {
      const demo = loadKiller();
      if (!demo) {
        json(res, 404, { error: "SWE-bench lite dataset not found" });
        return;
      }
      json(res, 200, demo);
      return;
    }

    if (req.method === "GET" && url.pathname === "/eval") {
      const summary = loadEval();
      if (!summary) {
        json(res, 404, { error: "eval has not finished", path: EVAL_RESULTS });
        return;
      }
      json(res, 200, summary);
      return;
    }

    if (req.method === "GET" && url.pathname === "/eval/cases") {
      const requested = url.searchParams.get("outcome") ?? "all";
      const outcomes = loadEvalOutcomes().map((row) => {
        const outcome =
          row.hybrid !== null && (row.bm25 === null || row.hybrid < row.bm25)
            ? "improved"
            : row.bm25 !== null && (row.hybrid === null || row.hybrid > row.bm25)
              ? "hurt"
              : "unchanged";
        return { ...row, outcome };
      });
      const cases = requested === "all" ? outcomes : outcomes.filter((row) => row.outcome === requested);
      json(res, 200, { cases });
      return;
    }

    if (!(await client.ready())) {
      json(res, 503, { error: "HydraDB is not ready. Run pnpm db:up." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/symbols") {
      const active = workspaces.active();
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (q.length < 2) {
        json(res, 200, { symbols: [] });
        return;
      }
      const exact = await client.query(
        `MATCH (s:${Label.Symbol} {name: $name, repo: $repo}) ` +
          `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 8`,
        { parameters: { name: q, repo: active.slug } },
      );
      const prefixed =
        exact.rows.length > 0
          ? { rows: [] as typeof exact.rows }
          : await client.query(
              `MATCH (s:${Label.Symbol} {repo: $repo}) WHERE s.name STARTS WITH $q ` +
                `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 12`,
              { parameters: { repo: active.slug, q } },
            );
      const rows = exact.rows.length > 0 ? exact.rows : prefixed.rows;
      json(res, 200, {
        symbols: rows.map((row) => ({
          qualname: String(row.qualname ?? ""),
          path: String(row.path ?? ""),
          kind: String(row.kind ?? ""),
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/impact") {
      const active = workspaces.active();
      const body = JSON.parse(await readBody(req)) as { symbol?: string; hops?: number };
      if (!body.symbol) {
        json(res, 400, { error: "symbol is required" });
        return;
      }
      const result = await impact(client, {
        repo: active.slug,
        symbol: body.symbol,
        maxHops: body.hops ?? 4,
      });
      if (!result) {
        json(res, 404, { error: `no symbol matching ${JSON.stringify(body.symbol)}` });
        return;
      }
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/retrieve") {
      const active = workspaces.active();
      const body = JSON.parse(await readBody(req)) as { issue?: string; limit?: number };
      if (!body.issue?.trim()) {
        json(res, 400, { error: "issue is required" });
        return;
      }
      const request = body.issue.trim();
      const wordCount = request.split(/\s+/).filter(Boolean).length;
      if (request.length < 18 || wordCount < 3) {
        json(res, 422, {
          code: "REQUEST_TOO_VAGUE",
          error: "Describe a concrete code change so Lumos can connect it to repository symbols.",
          guidance: "Name the behavior, error, function, feature, or stack trace you want the coding agent to investigate.",
          example: "The join template filter escapes its separator when autoescape is off.",
        });
        return;
      }
      const started = Date.now();
      const loaded = loadCorpus(active);
      const result = await retrieve(client, loaded.index, request, {
        repo: active.slug,
        files: loaded.files,
        limit: body.limit ?? 12,
      });
      const graphEvidenceFiles = result.ranked.filter((file) => file.evidence.length > 0).length;
      const graphChangedOrder = result.ranked[0]?.path !== result.lexical[0]?.path;
      const completedAt = new Date();
      const elapsedMs = Date.now() - started;
      const runId = createRunId();
      const quality = {
        filesChecked: loaded.files.length,
        filesSelected: result.ranked.length,
        graphEvidenceFiles,
        testsFound: result.tests.length,
        mode: graphChangedOrder ? "graph-promoted" as const : graphEvidenceFiles > 0 ? "graph-verified" as const : "text-only" as const,
      };
      const trace: RunTraceStep[] = [
        {
          id: "request",
          label: "Request accepted",
          detail: "A concrete code change was received and normalized.",
          status: "complete",
          elapsedMs: 0,
        },
        {
          id: "scan",
          label: "Repository checked",
          detail: `${loaded.files.length.toLocaleString("en-US")} indexed files were searched.`,
          status: "complete",
          elapsedMs: Math.max(0, elapsedMs - result.traversal.elapsedMs),
        },
        {
          id: "resolve",
          label: "Names resolved",
          detail: `${result.traversal.seedCount} request ${result.traversal.seedCount === 1 ? "seed was" : "seeds were"} matched to repository symbols.`,
          status: "complete",
          elapsedMs: result.traversal.elapsedMs,
        },
        {
          id: "walk",
          label: "HydraDB paths walked",
          detail: `${result.traversal.pathCount.toLocaleString("en-US")} CALLS, COVERS, and CO_CHANGES paths were inspected.`,
          status: "complete",
          elapsedMs: result.traversal.elapsedMs,
        },
        {
          id: "rank",
          label: "Context narrowed",
          detail: `${result.ranked.length} files and ${result.tests.length} connected tests were selected.`,
          status: "complete",
          elapsedMs,
        },
        {
          id: "handoff",
          label: "Agent context ready",
          detail: quality.mode === "text-only"
            ? "Text candidates are available, but graph proof is still missing."
            : "The graph-backed edit plan is ready for an IDE agent.",
          status: "complete",
          elapsedMs,
        },
      ];
      const payload = {
        runId,
        createdAt: completedAt.toISOString(),
        request,
        ranked: result.ranked,
        lexical: result.lexical,
        structural: result.structural,
        tests: result.tests,
        seeds: result.seeds.slice(0, 12),
        unresolved: result.unresolved.slice(0, 12),
        traversal: result.traversal,
        graphOnly: result.graphOnly,
        elapsedMs,
        withoutHydra: WITHOUT_HYDRA,
        quality,
        trace,
      };
      saveRun({
        id: runId,
        createdAt: new Date(started).toISOString(),
        completedAt: completedAt.toISOString(),
        status: "complete",
        request,
        repo: active.slug,
        elapsedMs,
        result: payload,
        trace,
        quality,
      });
      appendEvent({
        source: "workspace",
        tool: "lumos.preflight_change",
        state: "complete",
        summary: `${loaded.files.length} checked → ${result.ranked.length} files, ${result.tests.length} tests`,
        elapsedMs,
        runId,
      });
      json(res, 200, payload);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    corpusError = String((error as Error).message);
    json(res, 500, { error: corpusError });
  }
});

server.listen(PORT, () => {
  console.log(`lumos api  http://127.0.0.1:${PORT}  repo=${workspaces.active().slug}`);
});
