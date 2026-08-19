/**
 * HTTP surface for the demo. HydraDB stays on the other side of this process;
 * the browser never talks to it directly.
 *
 *   pnpm api
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

import {
  appendEvent,
  createRunId,
  getRun,
  listEvents,
  listRuns,
  saveRun,
  type RunTraceStep,
} from "./run-store.ts";

const PORT = Number(process.env.LUMOS_API_PORT ?? 8787);
const REPO = process.env.LUMOS_REPO ?? "django/django";
const ROOT = process.env.LUMOS_ROOT ?? "data/repos/django";
const KILLER_ID = "django__django-16873";
const LITE_PATH = "data/swebench/lite.jsonl";
const EVAL_SUMMARY = "data/eval/summary.json";
const EVAL_RESULTS = "data/eval/django-hybrid.jsonl";

const WITHOUT_HYDRA = [
  "no reverse call chain",
  "no test impact",
  "no transitive blast radius",
  "only lexical similarity",
];

const client = new HydraClient();
let corpus: Corpus | null = null;
let corpusError: string | null = null;

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

function loadCorpus(): Corpus {
  if (corpus) return corpus;
  corpus = buildCorpus(ROOT);
  return corpus;
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
      json(res, ready ? 200 : 503, { ready, repo: REPO });
      return;
    }

    if (req.method === "GET" && url.pathname === "/meta") {
      const ready = await client.ready();
      const files = ready ? loadCorpus().files.length : 0;
      json(res, ready ? 200 : 503, {
        ready,
        repo: REPO,
        root: ROOT,
        workspace: process.cwd(),
        files,
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

    if (!(await client.ready())) {
      json(res, 503, { error: "HydraDB is not ready. Run pnpm db:up." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/symbols") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (q.length < 2) {
        json(res, 200, { symbols: [] });
        return;
      }
      const exact = await client.query(
        `MATCH (s:${Label.Symbol} {name: $name, repo: $repo}) ` +
          `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 8`,
        { parameters: { name: q, repo: REPO } },
      );
      const prefixed =
        exact.rows.length > 0
          ? { rows: [] as typeof exact.rows }
          : await client.query(
              `MATCH (s:${Label.Symbol} {repo: $repo}) WHERE s.name STARTS WITH $q ` +
                `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 12`,
              { parameters: { repo: REPO, q } },
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
      const body = JSON.parse(await readBody(req)) as { symbol?: string; hops?: number };
      if (!body.symbol) {
        json(res, 400, { error: "symbol is required" });
        return;
      }
      const result = await impact(client, {
        repo: REPO,
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
      const loaded = loadCorpus();
      const result = await retrieve(client, loaded.index, request, {
        repo: REPO,
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
        repo: REPO,
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
  console.log(`lumos api  http://127.0.0.1:${PORT}  repo=${REPO}`);
});
