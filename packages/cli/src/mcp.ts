/**
 * MCP server. Cursor, Claude Code, Codex, and other IDE assistants call these
 * tools before they edit.
 *
 *   pnpm mcp
 *
 * Tools:
 *   lumos.preflight_change
 *   lumos.verify_patch
 *   lumos.find_relevant_files
 *   lumos.explain_file_rank
 *   lumos.impact
 *   lumos.tests_for_change
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { HydraClient } from "@lumos/graph";
import { buildCorpus, impact, retrieve, verifyPatch, type Corpus } from "@lumos/retrieve";

import { DEFAULT_REPO, DEFAULT_ROOT } from "./defaults.ts";

const PROTOCOL = "2024-11-05";
const REPO = DEFAULT_REPO;
const ROOT = DEFAULT_ROOT;
const EVENTS_PATH = process.env.LUMOS_EVENTS_PATH ?? "data/lumos/events.jsonl";

const client = new HydraClient();
let corpus: Corpus | null = null;

function loadCorpus(): Corpus {
  corpus ??= buildCorpus(ROOT);
  return corpus;
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: "lumos.preflight_change",
    description:
      "Run before editing. Search the indexed repository, use HydraDB paths to prove the relevant files and tests, and return a compact context contract with a SHA-256 digest.",
    inputSchema: {
      type: "object",
      properties: {
        issue_text: { type: "string", description: "The concrete code change the agent is about to make." },
        limit: { type: "number", description: "Maximum context files. Default 12." },
      },
      required: ["issue_text"],
    },
  },
  {
    name: "lumos.verify_patch",
    description:
      "Run after editing. Compare changed files and reported tests with a HydraDB-backed preflight and flag missing targets, unproved scope, or missing connected tests.",
    inputSchema: {
      type: "object",
      properties: {
        issue_text: { type: "string", description: "The original code-change request." },
        changed_files: { type: "array", items: { type: "string" }, description: "Repository-relative files changed by the agent." },
        tests_run: { type: "array", items: { type: "string" }, description: "Test paths or qualified test names run by the agent." },
      },
      required: ["issue_text", "changed_files"],
    },
  },
  {
    name: "lumos.find_relevant_files",
    description:
      "Given a bug report or issue, return the files to edit, the symbols involved, call-path evidence, and tests likely to fail. Uses BM25 to seed names and HydraDB to prove impact.",
    inputSchema: {
      type: "object",
      properties: {
        issue_text: { type: "string", description: "Bug report, stack trace, or SWE-bench issue text." },
        limit: { type: "number", description: "Max files to return. Default 12." },
      },
      required: ["issue_text"],
    },
  },
  {
    name: "lumos.explain_file_rank",
    description: "Explain why Lumos ranked a file for an issue, including why BM25 missed or over-ranked it.",
    inputSchema: {
      type: "object",
      properties: {
        issue_text: { type: "string" },
        file: { type: "string", description: "Repository-relative path." },
      },
      required: ["issue_text", "file"],
    },
  },
  {
    name: "lumos.impact",
    description: "Blast radius of a symbol: callers, callees, and covering tests via HydraDB traversal.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Qualified or bare symbol name." },
        hops: { type: "number" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "lumos.tests_for_change",
    description: "Tests that exercise a symbol, found by walking incoming COVERS/CALLS in HydraDB.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
];

function logEvent(event: {
  tool: string;
  state: "complete" | "error";
  summary: string;
  elapsedMs: number;
}): void {
  try {
    mkdirSync(dirname(EVENTS_PATH), { recursive: true });
    appendFileSync(
      EVENTS_PATH,
      `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), source: "mcp", repo: REPO, ...event })}\n`,
      "utf8",
    );
  } catch {
    // A tool call still succeeds if local activity logging is unavailable.
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

async function buildPreflight(issue: string, limit: number) {
  const loaded = loadCorpus();
  const result = await retrieve(client, loaded.index, issue, {
    repo: REPO,
    files: loaded.files,
    testFiles: loaded.testFiles,
    limit,
  });
  const graphEvidenceFiles = result.ranked.filter((file) => file.evidence.length > 0).length;
  const graphChangedOrder = result.ranked[0]?.path !== result.lexical[0]?.path;
  const mode = graphChangedOrder ? "graph-promoted" : graphEvidenceFiles > 0 ? "graph-verified" : "text-only";
  const contract = {
    schema: "ContextContractV1",
    request: issue,
    repository: REPO,
    targets: result.ranked.map((file, rank) => ({
      rank: rank + 1,
      path: file.path,
      wordRank: file.bm25Rank,
      reason: file.why[0] ?? "ranked by request context",
      evidence: file.evidence.map((item) =>
        [item.via, item.relTypes.join(" -> "), item.reached].filter(Boolean).join(" / "),
      ),
    })),
    tests: result.tests.map((test) => ({ path: test.path, symbol: test.qualname, via: test.via })),
    traversal: result.traversal,
  } as const;
  return {
    loaded,
    result,
    mode,
    contract,
    digest: createHash("sha256").update(canonicalJson(contract)).digest("hex"),
  };
}

function send(message: JsonRpc): void {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function ok(id: JsonRpc["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result });
}

function fail(id: JsonRpc["id"], message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(await client.ready())) {
    throw new Error("HydraDB is not ready. Run pnpm db:up.");
  }

  if (name === "lumos.find_relevant_files" || name === "lumos.preflight_change") {
    const issue = String(args.issue_text ?? "");
    if (!issue.trim()) throw new Error("issue_text is required");
    const preflight = await buildPreflight(issue, Number(args.limit ?? 12));
    const { result } = preflight;
    return {
      status: preflight.mode === "text-only" ? "needs-review" : "ready-to-edit",
      proof: preflight.mode === "text-only" ? "text-only" : "graph-proved",
      repository: { name: REPO, filesChecked: preflight.loaded.files.length },
      files: result.ranked.map((file, rank) => ({
        rank: rank + 1,
        path: file.path,
        why: file.why,
        bm25Rank: file.bm25Rank,
        symbols: file.evidence.map((item) => item.reached),
      })),
      tests: result.tests,
      hydradb: result.traversal,
      seeds: result.seeds.map((seed) => ({ via: seed.via, path: seed.path })),
      contextContract: name === "lumos.preflight_change" ? preflight.contract : undefined,
      digest: name === "lumos.preflight_change" ? preflight.digest : undefined,
    };
  }

  if (name === "lumos.verify_patch") {
    const issue = String(args.issue_text ?? "");
    const changedFiles = Array.isArray(args.changed_files) ? args.changed_files.map(String) : [];
    const testsRun = Array.isArray(args.tests_run) ? args.tests_run.map(String) : [];
    if (!issue.trim()) throw new Error("issue_text is required");
    if (changedFiles.length === 0) {
      throw new Error("changed_files must contain at least one repository-relative path");
    }
    const preflight = await buildPreflight(issue, 12);
    return {
      ...verifyPatch({
        changedFiles,
        testsRun,
        ranked: preflight.result.ranked,
        tests: preflight.result.tests,
        graphVerified: preflight.mode !== "text-only",
      }),
      repository: REPO,
      preflightDigest: preflight.digest,
      hydradb: preflight.result.traversal,
    };
  }

  if (name === "lumos.explain_file_rank") {
    const issue = String(args.issue_text ?? "");
    const file = String(args.file ?? "");
    if (!issue.trim() || !file) throw new Error("issue_text and file are required");
    const loaded = loadCorpus();
    const result = await retrieve(client, loaded.index, issue, {
      repo: REPO,
      files: loaded.files,
      testFiles: loaded.testFiles,
      limit: 50,
    });
    const hit = result.ranked.find((row) => row.path === file);
    const bm25 = result.lexical.find((row) => row.path === file);
    return {
      file,
      hybridRank: hit ? result.ranked.indexOf(hit) + 1 : null,
      bm25Rank: bm25?.bm25Rank ?? hit?.bm25Rank ?? null,
      why: hit?.why ?? ["not in the hybrid ranking"],
      evidence: hit?.evidence ?? [],
      withoutHydra: bm25
        ? "word search found this file by token overlap only"
        : "word search never returned this file — only the call/coverage graph did",
    };
  }

  if (name === "lumos.impact" || name === "lumos.tests_for_change") {
    const symbol = String(args.symbol ?? "");
    if (!symbol) throw new Error("symbol is required");
    const result = await impact(client, {
      repo: REPO,
      symbol,
      maxHops: Number(args.hops ?? 4),
    });
    if (!result) throw new Error(`no symbol matching ${JSON.stringify(symbol)}`);
    if (name === "lumos.tests_for_change") {
      return {
        seed: result.seed,
        tests: result.tests,
        hydradb: { engine: "HydraDB algo.MSpaths", elapsedMs: result.elapsedMs, pathCount: result.pathCount },
      };
    }
    return {
      seed: result.seed,
      symbols: result.symbols.slice(0, 40),
      tests: result.tests,
      hydradb: { engine: "HydraDB algo.MSpaths", elapsedMs: result.elapsedMs, pathCount: result.pathCount },
    };
  }

  throw new Error(`unknown tool ${name}`);
}

async function handle(message: JsonRpc): Promise<void> {
  const { id, method, params } = message;
  if (!method) return;

  if (method === "initialize") {
    ok(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "lumos", version: "0.0.1" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    ok(id, {});
    return;
  }
  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    const started = Date.now();
    try {
      const result = await callTool(name, args);
      logEvent({
        tool: name,
        state: "complete",
        summary: name === "lumos.verify_patch" ? "patch checked against graph-backed preflight" : "tool call completed",
        elapsedMs: Date.now() - started,
      });
      ok(id, text(result));
    } catch (error) {
      logEvent({
        tool: name,
        state: "error",
        summary: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      });
      fail(id, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    void handle(JSON.parse(body) as JsonRpc);
  }
});

process.stdin.resume();
process.stderr.write("lumos mcp  stdio  repo=" + REPO + "\n");
