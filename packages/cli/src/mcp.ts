/**
 * MCP server. Cursor, Claude Code, Codex, and other IDE assistants call these
 * tools before they edit.
 *
 *   pnpm mcp
 *
 * Tools:
 *   lumos.find_relevant_files
 *   lumos.explain_file_rank
 *   lumos.impact
 *   lumos.tests_for_change
 */
import { HydraClient } from "@lumos/graph";
import { buildCorpus, impact, retrieve, type Corpus } from "@lumos/retrieve";

import { DEFAULT_REPO, DEFAULT_ROOT } from "./defaults.ts";

const PROTOCOL = "2024-11-05";
const REPO = DEFAULT_REPO;
const ROOT = DEFAULT_ROOT;

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

  if (name === "lumos.find_relevant_files") {
    const issue = String(args.issue_text ?? "");
    if (!issue.trim()) throw new Error("issue_text is required");
    const loaded = loadCorpus();
    const result = await retrieve(client, loaded.index, issue, {
      repo: REPO,
      files: loaded.files,
      limit: Number(args.limit ?? 12),
    });
    return {
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
    try {
      ok(id, text(await callTool(name, args)));
    } catch (error) {
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
