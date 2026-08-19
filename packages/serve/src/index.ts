/**
 * HTTP surface for the demo. HydraDB stays on the other side of this process;
 * the browser never talks to it directly.
 *
 *   pnpm api
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { HydraClient, Label } from "@lumos/graph";
import { buildCorpus, impact, retrieve, summarizeEval, type Corpus, type EvalOutcome } from "@lumos/retrieve";

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
        files,
        engine: "HydraDB algo.MSpaths",
        product: "Lumos Impact Context for AI Coders",
      });
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
      json(res, 200, {
        ranked: result.ranked,
        lexical: result.lexical,
        structural: result.structural,
        tests: result.tests,
        seeds: result.seeds.slice(0, 12),
        unresolved: result.unresolved.slice(0, 12),
        traversal: result.traversal,
        graphOnly: result.graphOnly,
        elapsedMs: Date.now() - started,
        withoutHydra: WITHOUT_HYDRA,
        quality: {
          filesChecked: loaded.files.length,
          filesSelected: result.ranked.length,
          graphEvidenceFiles,
          testsFound: result.tests.length,
          mode: graphChangedOrder ? "graph-promoted" : graphEvidenceFiles > 0 ? "graph-verified" : "text-only",
        },
      });
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
