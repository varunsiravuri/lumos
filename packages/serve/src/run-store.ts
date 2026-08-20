import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const RUNS_PATH = process.env.LUMOS_RUNS_PATH ?? "data/lumos/runs.jsonl";
const EVENTS_PATH = process.env.LUMOS_EVENTS_PATH ?? "data/lumos/events.jsonl";

export interface RunTraceStep {
  id: string;
  label: string;
  detail: string;
  status: "complete";
  elapsedMs: number;
}

export interface StoredRun {
  id: string;
  createdAt: string;
  completedAt: string;
  status: "complete";
  request: string;
  repo: string;
  elapsedMs: number;
  result: Record<string, unknown>;
  trace: RunTraceStep[];
  quality: {
    filesChecked: number;
    filesSelected: number;
    graphEvidenceFiles: number;
    testsFound: number;
    mode: "graph-promoted" | "graph-verified" | "text-only";
  };
}

export interface LumosEvent {
  id: string;
  at: string;
  source: "workspace" | "mcp";
  tool: string;
  state: "complete" | "error";
  summary: string;
  elapsedMs?: number;
  runId?: string;
  repo?: string;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function lines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export function createRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function saveRun(run: StoredRun): void {
  ensureParent(RUNS_PATH);
  appendFileSync(RUNS_PATH, `${JSON.stringify(run)}\n`, "utf8");
}

export function getRun(id: string): StoredRun | null {
  return lines<StoredRun>(RUNS_PATH).findLast((run) => run.id === id) ?? null;
}

export function scopeRuns(runs: StoredRun[], repo?: string): StoredRun[] {
  return repo ? runs.filter((run) => run.repo === repo) : runs;
}

export function listRuns(limit = 30, repo?: string): StoredRun[] {
  return scopeRuns(lines<StoredRun>(RUNS_PATH), repo).slice(-limit).reverse();
}

export function appendEvent(event: Omit<LumosEvent, "id" | "at"> & Partial<Pick<LumosEvent, "id" | "at">>): LumosEvent {
  const stored: LumosEvent = {
    ...event,
    id: event.id ?? randomUUID(),
    at: event.at ?? new Date().toISOString(),
  };
  ensureParent(EVENTS_PATH);
  appendFileSync(EVENTS_PATH, `${JSON.stringify(stored)}\n`, "utf8");
  return stored;
}

export function scopeEvents(events: LumosEvent[], repo: string | undefined, runs: StoredRun[]): LumosEvent[] {
  if (!repo) return events;
  const runRepos = new Map(runs.map((run) => [run.id, run.repo]));
  return events.filter((event) => event.repo === repo || (event.runId ? runRepos.get(event.runId) === repo : false));
}

export function listEvents(limit = 50, repo?: string): LumosEvent[] {
  const events = lines<LumosEvent>(EVENTS_PATH);
  const runs = repo ? lines<StoredRun>(RUNS_PATH) : [];
  return scopeEvents(events, repo, runs).slice(-limit).reverse();
}
