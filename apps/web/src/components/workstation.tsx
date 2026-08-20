"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BracketsCurly,
  Bug,
  CaretDoubleLeft,
  ClockCounterClockwise,
  Database,
  Files,
  GitFork,
  GithubLogo,
  Graph,
  House,
  MagnifyingGlass,
  PlugsConnected,
  Plus,
  ShieldCheck,
  SidebarSimple,
  TerminalWindow,
  TrendUp,
} from "@phosphor-icons/react";

import { BlastGraph, type GraphLink, type GraphNode } from "./blast-graph";
import { writeLastSource } from "@/lib/last-source";

const API = process.env.NEXT_PUBLIC_LUMOS_API ?? "/api";

interface ImpactHit {
  qualname: string;
  path: string;
  kind: string;
  isTest: boolean;
  depth: number;
}

interface ImpactResult {
  seed: { qualname: string; path: string; kind: string };
  elapsedMs: number;
  pathCount: number;
  symbols: ImpactHit[];
  tests: ImpactHit[];
  edges: { from: string; to: string; type: string }[];
}

interface Evidence {
  via: string;
  depth: number;
  relTypes: string[];
  reached: string;
}

interface RankedFile {
  path: string;
  score: number;
  lexicalScore: number;
  graphScore: number;
  bm25Rank: number | null;
  evidence: Evidence[];
  why: string[];
}

interface TestHit {
  path: string;
  qualname: string;
  depth: number;
  via: string;
}

interface RetrieveResult {
  runId: string;
  createdAt: string;
  repo: string;
  request: string;
  ranked: RankedFile[];
  lexical: RankedFile[];
  tests: TestHit[];
  seeds: { via: string; path: string; ukey: string }[];
  traversal: {
    engine: string;
    direction: string;
    relTypes: string[];
    seedCount: number;
    pathCount: number;
    elapsedMs: number;
  };
  elapsedMs: number;
  withoutHydra: string[];
  quality: {
    filesChecked: number;
    filesSelected: number;
    graphEvidenceFiles: number;
    testsFound: number;
    testFilesDetected?: number;
    requestSeedsResolved?: number;
    unresolvedMentions?: number;
    mode: "graph-promoted" | "graph-verified" | "text-only";
  };
  trace: {
    id: string;
    label: string;
    detail: string;
    status: "complete";
    elapsedMs: number;
  }[];
}

interface Meta {
  ready: boolean;
  serviceReady: boolean;
  repo: string;
  label?: string;
  sample?: boolean;
  source?: "sample" | "github" | "local";
  status: "ready" | "indexing" | "error" | "unindexed";
  files: number;
  graphFiles: number;
  graphSymbols: number;
  graphSymbolsCapped: boolean;
  testFiles: number;
  workspaces?: number;
  engine: string;
  runs: number;
  capabilities: string[];
  mcpTools: string[];
}

interface RunSummary {
  id: string;
  createdAt: string;
  completedAt: string;
  status: "complete";
  request: string;
  repo: string;
  elapsedMs: number;
  quality: RetrieveResult["quality"];
}

interface StoredRun extends RunSummary {
  result: RetrieveResult;
  trace: RetrieveResult["trace"];
}

interface ActivityEvent {
  id: string;
  at: string;
  source: "workspace" | "mcp";
  tool: string;
  state: "complete" | "error";
  summary: string;
  elapsedMs?: number;
  runId?: string;
}

interface PatchVerification {
  runId: string;
  verifiedAt: string;
  status: "ready" | "review" | "blocked";
  score: number;
  summary: string;
  primaryTarget: string | null;
  changedFiles: string[];
  unexpectedFiles: string[];
  matchedTests: string[];
  missingTests: string[];
  checks: {
    id: string;
    title: string;
    state: "pass" | "review" | "fail";
    detail: string;
  }[];
}

interface EvalSummary {
  n: number;
  methods: {
    bm25: { at1: number; at3: number; mrr: number };
    graph: { at1: number; at3: number; mrr: number };
    hybrid: { at1: number; at3: number; mrr: number };
  };
  hybridVsBm25: { improved: number; hurt: number; tie: number };
  helped?: string[];
  hurt?: string[];
  failureMode: string;
}

interface RepositoryRecord {
  slug: string;
  label: string;
  source: "sample" | "github" | "local";
  status: "ready" | "indexing" | "error" | "unindexed";
  files: number;
  graphFiles: number;
  graphSymbols: number;
  graphSymbolsCapped: boolean;
  graphReady: boolean;
  testFiles: number;
  addedAt: string;
  updatedAt: string;
  url?: string;
  error?: string;
  active?: boolean;
}

interface ImportJob {
  id: string;
  slug: string;
  url: string;
  status: "queued" | "cloning" | "indexing" | "ready" | "error";
  message: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

interface EvalCase {
  instanceId: string;
  goldFiles: string[];
  bm25: number | null;
  graph: number | null;
  hybrid: number | null;
  candidates: number;
  retrieveMs: number;
  outcome: "improved" | "hurt" | "unchanged";
}

interface Demo {
  id: string;
  issue: string;
  gold: string[];
  note: string;
  repository: string;
  files: number;
}

interface ContextContract {
  schema: "ContextContractV1";
  request: string;
  repository: string;
  targets: {
    path: string;
    rank: number;
    wordRank: number | null;
    reason: string;
    evidence: string[];
  }[];
  tests: { path: string; symbol: string; via: string }[];
  traversal: RetrieveResult["traversal"];
}

export type WorkspaceView =
  | "welcome"
  | "overview"
  | "request"
  | "live"
  | "proof"
  | "guard"
  | "runs"
  | "graph"
  | "repository"
  | "repositories"
  | "connect"
  | "benchmarks";
type CopyTarget = "path" | "markdown" | "json" | "config" | null;

const workspacePages: { id: WorkspaceView; label: string; eyebrow: string }[] = [
  { id: "overview", label: "Overview", eyebrow: "Workspace" },
  { id: "repositories", label: "Repositories", eyebrow: "Manage source code" },
  { id: "runs", label: "Preflight runs", eyebrow: "Saved evidence" },
  { id: "request", label: "New preflight", eyebrow: "Describe a change" },
  { id: "graph", label: "Graph explorer", eyebrow: "Follow a symbol" },
  { id: "connect", label: "Agent connection", eyebrow: "MCP and CLI" },
  { id: "benchmarks", label: "Benchmarks", eyebrow: "Measured retrieval" },
];

const runPages: { id: WorkspaceView; label: string; eyebrow: string }[] = [
  { id: "live", label: "Summary", eyebrow: "Trace and handoff" },
  { id: "proof", label: "Evidence", eyebrow: "Files, paths, and tests" },
  { id: "guard", label: "Patch Guard", eyebrow: "Verify the resulting edit" },
];

const SAMPLE_ISSUE =
  "Template filter `join` should not escape the joining string if `autoescape` is `off`";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

const SIDEBAR_STORAGE_KEY = "lumos-sidebar-open";

function readSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  return stored === null ? true : stored === "true";
}

const buttonBase =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-[background-color,border-color,color,transform] duration-100 active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

function sourceName(meta: Meta | null): string {
  if (meta?.label) return meta.label;
  if (!meta?.repo || meta.repo === "django/django") return "Django demo";
  return meta.repo;
}

function repositoryStatus(repository: RepositoryRecord): string {
  if (repository.status === "ready") {
    return `${fmt(repository.files)} files · ${fmt(repository.testFiles ?? 0)} test files · graph indexed`;
  }
  if (repository.status === "unindexed") return `${fmt(repository.files)} files · graph not indexed`;
  if (repository.status === "indexing") return "Indexing graph…";
  return repository.error ?? "Import failed. Retry from Add repository.";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}

function relationLabel(evidence: Evidence | undefined): string {
  if (!evidence) return "word match";
  if (evidence.relTypes.includes("COVERS")) return "covered by test";
  if (evidence.relTypes.includes("CO_CHANGES")) return "changed together";
  if (evidence.relTypes.includes("CALLS")) return "call chain";
  if (evidence.relTypes.includes("IMPORTS")) return "import path";
  if (evidence.depth === 0) return "named seed";
  return "graph evidence";
}

function workspaceHref(view: WorkspaceView, runId?: string | null): string {
  if (view === "welcome") return "/app";
  if (view === "overview") return "/app/workspace";
  if (view === "request") return "/app/new";
  if (view === "runs") return "/app/runs";
  if (view === "graph") return "/app/graph";
  if (view === "repository") return "/app/repository";
  if (view === "repositories") return "/app/repositories";
  if (view === "connect") return "/app/connect";
  if (view === "benchmarks") return "/app/benchmarks";
  if (!runId) return "/app/new";
  if (view === "proof") return `/app/runs/${encodeURIComponent(runId)}/proof`;
  if (view === "guard") return `/app/runs/${encodeURIComponent(runId)}/guard`;
  return `/app/runs/${encodeURIComponent(runId)}`;
}

function backTarget(view: WorkspaceView): { href: string; label: string } {
  if (view === "welcome") return { href: "/", label: "Back to Lumos site" };
  if (view === "overview" || view === "repository") return { href: "/app", label: "Back to source picker" };
  return { href: "/app/workspace", label: "Back to Lumos workspace" };
}

function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function requestProblem(value: string): string | null {
  const trimmed = value.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (trimmed.length < 18 || words.length < 3) {
    return "Tell Lumos what should change. Name a behavior, error, function, feature, or stack trace.";
  }
  return null;
}

function compactRequest(value: string): string {
  const firstUsefulLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? value.trim();
  return firstUsefulLine.length > 180 ? `${firstUsefulLine.slice(0, 177).trim()}…` : firstUsefulLine;
}

function contractMarkdown(contract: ContextContract): string {
  const targets = contract.targets
    .map(
      (target) =>
        `${target.rank}. \`${target.path}\`\n   - ${target.reason}\n   - Evidence: ${target.evidence.join("; ") || "word search only"}`,
    )
    .join("\n");
  const tests = contract.tests.length
    ? contract.tests.map((test) => `- \`${test.symbol}\` - ${test.via}`).join("\n")
    : "- No covering tests were found.";

  return `# Lumos context handoff\n\n## Request\n${contract.request}\n\n## Ranked targets\n${targets}\n\n## Tests\n${tests}\n\n## Graph traversal\n- Engine: ${contract.traversal.engine}\n- Direction: ${contract.traversal.direction}\n- Relationships: ${contract.traversal.relTypes.join(", ")}\n- Paths checked: ${contract.traversal.pathCount}\n- Walk time: ${contract.traversal.elapsedMs} ms`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function Workstation({ view = "welcome", runId: initialRunId = null }: { view?: WorkspaceView; runId?: string | null }) {
  const router = useRouter();
  const [issue, setIssue] = useState("");
  const [activeRequest, setActiveRequest] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [evalCases, setEvalCases] = useState<EvalCase[]>([]);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [gold, setGold] = useState<string[]>([]);
  const [busy, setBusy] = useState(Boolean(initialRunId));
  const [error, setError] = useState<string | null>(null);
  const [retrieve, setRetrieve] = useState<RetrieveResult | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [digest, setDigest] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const issueRef = useRef<HTMLTextAreaElement>(null);
  const fileRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const currentRunId = retrieve?.runId ?? initialRunId;

  const navigate = useCallback((nextView: WorkspaceView, replace = false) => {
    const href = workspaceHref(nextView, currentRunId);
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [currentRunId, router]);

  const refreshMeta = useCallback(async () => {
    try {
      const response = await fetch(`${API}/meta`);
      if (!response.ok) throw new Error("meta unavailable");
      const next = (await response.json()) as Meta;
      setMeta(next);
      if (next.repo && next.files > 0) writeLastSource({ repo: next.repo, label: next.label ?? sourceName(next) });
    } catch {
      setMeta(null);
    }
  }, []);

  const refreshEval = useCallback(async () => {
    try {
      const [summaryResponse, casesResponse] = await Promise.all([
        fetch(`${API}/eval`),
        fetch(`${API}/eval/cases`),
      ]);
      if (!summaryResponse.ok) throw new Error("evaluation unavailable");
      setEvalSummary((await summaryResponse.json()) as EvalSummary);
      if (casesResponse.ok) {
        const body = (await casesResponse.json()) as { cases: EvalCase[] };
        setEvalCases(body.cases);
      }
    } catch {
      setEvalSummary(null);
      setEvalCases([]);
    }
  }, []);

  const refreshRepositories = useCallback(async () => {
    try {
      const response = await fetch(`${API}/repositories`);
      if (!response.ok) throw new Error("repositories unavailable");
      const body = (await response.json()) as { repositories: RepositoryRecord[] };
      setRepositories(body.repositories);
    } catch {
      setRepositories([]);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const response = await fetch(`${API}/runs?limit=30`);
      if (!response.ok) throw new Error("runs unavailable");
      const body = (await response.json()) as { runs: RunSummary[] };
      setRuns(body.runs);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      const response = await fetch(`${API}/events?limit=30`);
      if (!response.ok) throw new Error("events unavailable");
      const body = (await response.json()) as { events: ActivityEvent[] };
      setEvents(body.events);
    } catch {
      setEvents([]);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshMeta(), refreshEval(), refreshRuns(), refreshEvents(), refreshRepositories()]);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshEval, refreshEvents, refreshMeta, refreshRepositories, refreshRuns]);

  useEffect(() => {
    if (!initialRunId || retrieve?.runId === initialRunId) return;
    const controller = new AbortController();
    void fetch(`${API}/runs/${encodeURIComponent(initialRunId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as StoredRun & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "run could not be opened");
        const restored = { ...body.result, repo: body.result.repo || body.repo, request: body.result.request || body.request };
        setActiveRequest(compactRequest(body.request));
        setRetrieve(restored);
        setSelectedFile(restored.ranked[0]?.path ?? null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "run could not be opened");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [initialRunId, retrieve?.runId]);

  const lexicalRank = useMemo(
    () => new Map(retrieve?.lexical.map((file, index) => [file.path, index + 1]) ?? []),
    [retrieve],
  );
  const selectedRanked = retrieve?.ranked.find((file) => file.path === selectedFile) ?? null;
  const graphReady = meta?.ready === true;
  const seedToWalk = selectedRanked?.evidence[0]?.reached ?? retrieve?.seeds[0]?.via ?? "";

  const contract = useMemo<ContextContract | null>(() => {
    if (!retrieve) return null;
    return {
      schema: "ContextContractV1",
      request: retrieve.request || activeRequest,
      repository: retrieve.repo ?? meta?.repo ?? "local repository",
      targets: retrieve.ranked.map((file, index) => ({
        path: file.path,
        rank: index + 1,
        wordRank: lexicalRank.get(file.path) ?? null,
        reason: file.why[0] ?? "Ranked by request context",
        evidence: file.evidence.map((item) =>
          [item.via, item.relTypes.join(" -> "), item.reached].filter(Boolean).join(" / "),
        ),
      })),
      tests: retrieve.tests.map((test) => ({ path: test.path, symbol: test.qualname, via: test.via })),
      traversal: retrieve.traversal,
    };
  }, [activeRequest, lexicalRank, meta?.repo, retrieve]);

  const contractJson = useMemo(() => (contract ? JSON.stringify(contract, null, 2) : ""), [contract]);
  const contractCanonical = useMemo(() => (contract ? canonicalJson(contract) : ""), [contract]);
  const markdown = useMemo(() => (contract ? contractMarkdown(contract) : ""), [contract]);

  useEffect(() => {
    let cancelled = false;
    if (!contractCanonical) return;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(contractCanonical)).then((buffer) => {
      if (cancelled) return;
      setDigest(Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    });
    return () => {
      cancelled = true;
    };
  }, [contractCanonical]);

  const graphNodes: GraphNode[] = useMemo(() => {
    if (!impact) return [];
    return [...impact.symbols, ...impact.tests].map((hit) => ({
      id: hit.qualname,
      label: hit.qualname,
      path: hit.path,
      depth: hit.depth,
      isTest: hit.isTest,
    }));
  }, [impact]);

  const graphLinks: GraphLink[] = useMemo(
    () => (impact ? impact.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })) : []),
    [impact],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      if (event.key === "/" && !typing) {
        event.preventDefault();
        navigate("request");
        window.setTimeout(() => issueRef.current?.focus(), 0);
      }
      if (event.key === "Escape") setMapOpen(false);
      if (view !== "proof" || !retrieve || typing || mapOpen) return;
      const paths = retrieve.ranked.map((file) => file.path);
      const index = selectedFile ? paths.indexOf(selectedFile) : -1;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = paths[Math.min(paths.length - 1, Math.max(0, index + 1))];
        if (next) {
          setSelectedFile(next);
          fileRefs.current.get(next)?.focus();
        }
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const previous = paths[Math.max(0, index <= 0 ? 0 : index - 1)];
        if (previous) {
          setSelectedFile(previous);
          fileRefs.current.get(previous)?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapOpen, navigate, retrieve, selectedFile, view]);

  async function runRetrieve(
    text = issue,
    options: { displayText?: string; source?: "custom" | "demo" } = {},
  ) {
    const source = options.source ?? "custom";
    const problem = requestProblem(text);
    if (problem) {
      setRequestError(problem);
      navigate("request");
      window.setTimeout(() => issueRef.current?.focus(), 0);
      return;
    }
    setBusy(true);
    setError(null);
    setRequestError(null);
    setMapOpen(false);
    if (source === "custom") {
      setDemo(null);
      setGold([]);
    }
    try {
      const response = await fetch(`${API}/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue: text }),
      });
      const body = (await response.json()) as RetrieveResult & { error?: string; guidance?: string };
      if (!response.ok) {
        if (response.status === 422) {
          setRequestError(body.guidance ?? body.error ?? "Please describe a more specific code change.");
          navigate("request");
          return;
        }
        throw new Error(body.error ?? "retrieve failed");
      }
      setActiveRequest(compactRequest(options.displayText ?? text));
      setRetrieve(body);
      setSelectedFile(body.ranked[0]?.path ?? null);
      await Promise.all([refreshRuns(), refreshEvents(), refreshMeta()]);
      router.push(workspaceHref("live", body.runId), { scroll: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "retrieve failed");
    } finally {
      setBusy(false);
    }
  }

  async function openRun(runId: string, destination: WorkspaceView = "live") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/runs/${encodeURIComponent(runId)}`);
      const body = (await response.json()) as StoredRun & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "run could not be opened");
      const restored = { ...body.result, repo: body.result.repo || body.repo, request: body.result.request || body.request };
      setActiveRequest(compactRequest(body.request));
      setRetrieve(restored);
      setSelectedFile(restored.ranked[0]?.path ?? null);
      router.push(workspaceHref(destination, runId), { scroll: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "run could not be opened");
    } finally {
      setBusy(false);
    }
  }

  async function loadDemo() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/demo`, { method: "POST" });
      const body = (await response.json()) as Demo & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "demo failed");
      setDemo(body);
      setGold(body.gold);
      setIssue(SAMPLE_ISSUE);
      setRetrieve(null);
      setImpact(null);
      await Promise.all([refreshMeta(), refreshRepositories(), refreshRuns(), refreshEvents()]);
      await runRetrieve(body.issue, { displayText: SAMPLE_ISSUE, source: "demo" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "demo failed");
      setBusy(false);
    }
  }

  async function walkSymbol(symbol: string, openOverlay = true) {
    if (!symbol) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/impact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const body = (await response.json()) as ImpactResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "impact failed");
      setImpact(body);
      setSelectedNode(body.seed.qualname);
      setMapOpen(openOverlay);
    } catch (err) {
      setError(err instanceof Error ? err.message : "impact failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string, target: Exclude<CopyTarget, null>) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      setError("Could not copy to the clipboard");
    }
  }

  async function activateRepository(slug: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/repositories/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository could not be activated");
      setRetrieve(null);
      setActiveRequest("");
      setSelectedFile(null);
      setImpact(null);
      setDemo(null);
      setGold([]);
      await Promise.all([refreshMeta(), refreshRepositories(), refreshRuns(), refreshEvents()]);
      router.push("/app/workspace", { scroll: false });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repository could not be activated");
    } finally {
      setBusy(false);
    }
  }

  function downloadContract() {
    if (!contractJson) return;
    const href = URL.createObjectURL(new Blob([contractJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "lumos-context-contract.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  const repositorySelected = view !== "welcome" && view !== "repository";
  const back = backTarget(view);

  return (
    <div className="workstation-sky min-h-dvh overflow-hidden text-foreground">
      <div className="workstation-shell relative flex h-dvh overflow-hidden bg-background">
        <aside
          className={`platform-sidebar hidden shrink-0 flex-col border-r border-line lg:flex ${sidebarOpen ? "platform-sidebar-open" : "platform-sidebar-closed"}`}
          aria-hidden={!sidebarOpen}
        >
          <div className="platform-sidebar-inner flex h-full w-[16.5rem] flex-col">
            <div className="mx-4 mt-5 flex items-center gap-3 lg:mx-3 lg:mt-[1.15rem]">
              <Link href={back.href} className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground lg:hidden ${focusRing}`} aria-label={back.label}><ArrowLeft size={17} /></Link>
              <Link href="/app/workspace" className={`min-w-0 flex-1 truncate rounded-sm text-[15px] font-semibold tracking-[0.42em] text-foreground ${focusRing}`} aria-label="Lumos workspace home">LUMOS</Link>
            </div>
            <Link href={repositorySelected ? "/app/repositories" : "/app/repository"} className={`mx-3 mt-7 flex items-center gap-3 rounded-lg border border-[#c8dce7] bg-panel px-3 py-3 text-left hover:border-[#8fbdd4] ${focusRing}`}>
              <span className="grid h-8 w-8 shrink-0 place-items-center text-lexical"><GitFork size={19} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{repositorySelected ? sourceName(meta) : "Choose repository"}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">{repositorySelected ? `${fmt(meta?.files ?? 0)} searchable files` : "No source selected"}</span>
              </span>
            </Link>
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              <WorkspaceNav view={view} runId={currentRunId} runs={runs} events={events} connected={repositorySelected} />
              {repositorySelected && repositories.length ? (
                <section className="mt-7 border-t border-line pt-5" aria-labelledby="recent-repositories-title">
                  <p id="recent-repositories-title" className="px-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Recent repositories</p>
                  <ul className="mt-2 space-y-1">
                    {repositories.slice(0, 4).map((repository) => (
                      <li key={repository.slug}>
                        <button
                          type="button"
                          disabled={repository.status !== "ready" || repository.active}
                          onClick={() => void activateRepository(repository.slug)}
                          className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-xs hover:bg-[#eaf5fb] disabled:opacity-100 ${focusRing}`}
                        >
                          <GitFork size={15} className="shrink-0 text-muted group-hover:text-lexical" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">{repository.label}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-muted">{repositoryStatus(repository)}</span>
                          </span>
                          <span className={`h-1.5 w-1.5 rounded-full ${repository.graphReady ? "bg-[#2f9e68]" : repository.status === "error" ? "bg-accent" : "border border-[#b8cbd6]"}`} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        </aside>

        {sidebarOpen ? (
          <button
            type="button"
            onClick={toggleSidebar}
            className={`platform-sidebar-rail platform-sidebar-rail-open ${focusRing}`}
            aria-label="Close sidebar"
            title="Close sidebar (⌘B)"
          >
            <CaretDoubleLeft size={14} weight="bold" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleSidebar}
            className={`platform-sidebar-rail platform-sidebar-rail-closed ${focusRing}`}
            aria-label="Open sidebar"
            title="Open sidebar (⌘B)"
          >
            <SidebarSimple size={16} />
          </button>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {repositorySelected ? <header className="platform-topbar flex min-h-14 shrink-0 items-center justify-between border-b border-line px-4 lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link href={back.href} className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground ${focusRing}`} aria-label={back.label}><ArrowLeft size={16} /></Link>
              <span className="hidden h-4 w-px bg-line lg:block" />
              <p className="hidden truncate text-sm font-medium text-foreground lg:block">{workspaceTitle(view, meta)}</p>
              <Link href="/app/workspace" className={`text-[13px] font-semibold tracking-[0.32em] lg:hidden ${focusRing}`}>LUMOS</Link>
              <span className="hidden h-4 w-px bg-line sm:block lg:hidden" />
              <p className="hidden truncate text-sm font-medium text-foreground sm:block lg:hidden">{workspaceTitle(view, meta)}</p>
            </div>
            <div className="flex items-center gap-3">
              {repositorySelected ? <span className="hidden md:block"><StatusPill ready={graphReady}>{graphReady ? "Graph indexed" : meta?.serviceReady ? "Graph not indexed" : "Graph offline"}</StatusPill></span> : null}
              {repositorySelected && view !== "request" ? (
                <Link href="/app/new" className={`${buttonBase} gap-2 bg-foreground px-3.5 text-panel hover:bg-[#2a3540] ${focusRing}`}>
                  <Plus size={15} weight="bold" /> <span className="sm:hidden">New</span><span className="hidden sm:inline">New preflight</span>
                </Link>
              ) : null}
            </div>
          </header> : (
            <header className="platform-topbar flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 lg:px-6">
              <Link href={back.href} className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground ${focusRing}`} aria-label={back.label}><ArrowLeft size={16} /></Link>
              <Link href="/app/workspace" className={`text-[13px] font-semibold tracking-[0.32em] lg:hidden ${focusRing}`}>LUMOS</Link>
            </header>
          )}

          {!meta && repositorySelected ? (
            <Notice tone="orange" message="The Lumos API is unavailable. Start it locally, then retry.">
              <button type="button" onClick={() => void refreshMeta()} className={`${buttonBase} min-h-8 border border-line bg-panel px-3 text-foreground ${focusRing}`}>Retry</button>
            </Notice>
          ) : meta && !meta.serviceReady && repositorySelected ? (
            <Notice tone="blue" message={<>HydraDB is offline. Bootstrap with <code className="font-mono font-semibold text-foreground">pnpm start</code> or <code className="font-mono font-semibold text-foreground">pnpm db:up</code>.</>}>
              <button type="button" onClick={() => void refreshMeta()} className={`${buttonBase} min-h-8 border border-line bg-panel px-3 text-foreground ${focusRing}`}>Retry</button>
            </Notice>
          ) : meta?.serviceReady && !graphReady && repositorySelected ? (
            <Notice tone="orange" message="Files were found, but this repository has no HydraDB graph yet. Index it before running a preflight.">
              <Link href="/app/repository" className={`${buttonBase} min-h-8 border border-[#efc7b3] bg-panel px-3 text-foreground ${focusRing}`}>Index repository</Link>
            </Notice>
          ) : null}

          {error ? (
            <Notice tone="orange" message={error}>
              {initialRunId && !retrieve ? (
                <Link href="/app/runs" className={`${buttonBase} min-h-8 border border-[#efc7b3] bg-panel px-3 text-foreground ${focusRing}`}>Open runs</Link>
              ) : (
                <button type="button" onClick={() => setError(null)} className={`${buttonBase} min-h-8 border border-[#efc7b3] bg-panel px-3 text-foreground ${focusRing}`}>Dismiss</button>
              )}
            </Notice>
          ) : null}

          {repositorySelected ? <div className="border-b border-line bg-panel lg:hidden">
            <WorkspaceNav view={view} runId={currentRunId} runs={runs} events={events} connected={repositorySelected} mobile />
          </div> : null}

            {retrieve && (view === "live" || view === "proof" || view === "guard") ? (
              <RunContext view={view} request={activeRequest} retrieve={retrieve} />
            ) : null}

            <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
              {busy && initialRunId && !retrieve ? <ResultSkeleton /> : null}
              {view === "welcome" ? (
                <WelcomeView
                  meta={meta}
                  graphReady={graphReady}
                  onDemo={() => void loadDemo()}
                  onRepository={() => navigate("repository")}
                />
              ) : null}
              {view === "overview" ? (
                <OverviewView
                  meta={meta}
                  runs={runs}
                  events={events}
                  repositories={repositories}
                  graphReady={graphReady}
                  serviceReady={meta?.serviceReady === true}
                  onNew={() => navigate("request")}
                  onOpenRun={(id) => void openRun(id)}
                  onKillerDemo={() => void loadDemo()}
                />
              ) : null}
              {view === "request" ? (
                <RequestView
                  issue={issue}
                  setIssue={(value) => {
                    setIssue(value);
                    setRequestError(null);
                  }}
                  requestError={requestError}
                  issueRef={issueRef}
                  graphReady={graphReady}
                  busy={busy}
                  retrieve={retrieve}
                  meta={meta}
                  onRun={(value) => void runRetrieve(value)}
                  onDemo={() => void loadDemo()}
                  onProof={() => navigate("live")}
                />
              ) : null}
              {view === "live" && (!initialRunId || retrieve) ? (
                <LiveRunView
                  retrieve={retrieve}
                  request={activeRequest}
                  contract={contract}
                  contractJson={contractJson}
                  markdown={markdown}
                  digest={digest}
                  copied={copied}
                  events={events}
                  onCopy={copyText}
                  onDownload={downloadContract}
                  onRequest={() => navigate("request")}
                  onProof={() => navigate("proof")}
                  onGuard={() => navigate("guard")}
                  onVerified={() => void refreshEvents()}
                />
              ) : null}
              {view === "proof" && (!initialRunId || retrieve) ? (
                <ProofView
                  retrieve={retrieve}
                  busy={busy}
                  demo={demo}
                  gold={gold}
                  selectedFile={selectedFile}
                  selectedRanked={selectedRanked}
                  lexicalRank={lexicalRank}
                  copied={copied === "path"}
                  graphReady={graphReady}
                  seedToWalk={seedToWalk}
                  fileRefs={fileRefs}
                  onSelect={setSelectedFile}
                  onCopy={(path) => void copyText(path, "path")}
                  onWalk={() => void walkSymbol(seedToWalk)}
                  onRequest={() => navigate("request")}
                  onHandoff={() => navigate("live")}
                />
              ) : null}
              {view === "guard" && (!initialRunId || retrieve) ? (
                <PatchGuardView
                  key={retrieve?.runId ?? "no-run"}
                  retrieve={retrieve}
                  onRequest={() => navigate("request")}
                  onVerified={() => void refreshEvents()}
                />
              ) : null}
              {view === "runs" ? (
                <RunsView
                  runs={runs}
                  loading={runsLoading}
                  currentRunId={retrieve?.runId ?? null}
                  onRefresh={() => void refreshRuns()}
                  onNew={() => navigate("request")}
                />
              ) : null}
              {view === "connect" ? (
                <ConnectAgentView
                  meta={meta}
                  events={events}
                  copied={copied}
                  onCopy={copyText}
                />
              ) : null}
              {view === "repository" ? (
                <RepositoryView
                  serviceReady={meta?.serviceReady === true}
                  repositories={repositories}
                  onDemo={() => void loadDemo()}
                  onReady={async () => {
                    await Promise.all([refreshMeta(), refreshRepositories()]);
                    navigate("overview");
                  }}
                  copied={copied}
                  onCopy={copyText}
                />
              ) : null}
              {view === "repositories" ? (
                <RepositoryBrowserView
                  repositories={repositories}
                  meta={meta}
                  graphReady={graphReady}
                  onActivate={(slug) => void activateRepository(slug)}
                  onRefresh={() => void Promise.all([refreshMeta(), refreshRepositories()])}
                />
              ) : null}
              {view === "graph" ? (
                <GraphExplorerView
                  key={meta?.repo ?? "no-repository"}
                  repo={meta?.repo ?? ""}
                  impact={impact}
                  graphNodes={graphNodes}
                  graphLinks={graphLinks}
                  selectedNode={selectedNode}
                  graphReady={graphReady}
                  busy={busy}
                  onWalk={(symbol) => void walkSymbol(symbol, false)}
                  onSelect={setSelectedNode}
                />
              ) : null}
              {view === "benchmarks" ? (
                <BenchmarkView
                  summary={evalSummary}
                  cases={evalCases}
                  demo={demo}
                  serviceReady={meta?.serviceReady === true}
                  onRefresh={() => void refreshEval()}
                  onRunDemo={() => void loadDemo()}
                />
              ) : null}
            </main>

            {mapOpen && impact ? (
              <section className="absolute inset-0 z-30 flex flex-col bg-background" role="dialog" aria-modal="true" aria-labelledby="chain-map-title">
                <div className="flex min-h-16 items-center justify-between gap-4 border-b border-line bg-panel px-4 lg:px-6">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">HydraDB relationship walk</p>
                    <h2 id="chain-map-title" className="mt-1 truncate text-sm font-semibold">The chain from {impact.seed.qualname}</h2>
                  </div>
                  <div className="flex items-center gap-4">
                    <p className="hidden font-mono text-xs text-muted sm:block">{impact.elapsedMs} ms · {fmt(impact.pathCount)} paths · {impact.tests.length} tests</p>
                    <button type="button" onClick={() => setMapOpen(false)} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>
                      Close
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <BlastGraph seed={impact.seed.qualname} nodes={graphNodes} links={graphLinks} selected={selectedNode} onSelect={setSelectedNode} />
                </div>
              </section>
            ) : null}
          </div>
      </div>
    </div>
  );
}

function WorkspaceNav({
  view,
  runId,
  runs,
  events,
  connected,
  mobile = false,
}: {
  view: WorkspaceView;
  runId: string | null;
  runs: RunSummary[];
  events: ActivityEvent[];
  connected: boolean;
  mobile?: boolean;
}) {
  if (mobile) {
    if (!connected) return null;
    return (
      <nav className="flex overflow-x-auto px-2" aria-label="Workspace pages">
        {workspacePages.map((item) => (
          <Link
            key={item.id}
            href={workspaceHref(item.id, runId)}
            aria-current={view === item.id ? "page" : undefined}
            className={`relative flex min-h-12 min-w-[7.5rem] shrink-0 items-center justify-center gap-2 px-2 text-center text-[11px] font-semibold sm:text-xs ${focusRing} ${view === item.id ? "text-foreground" : "text-muted"}`}
          >
            <ViewGlyph view={item.id} active={view === item.id} compact />
            {item.label}
            {view === item.id ? <span className="absolute inset-x-5 bottom-0 h-0.5 bg-accent" /> : null}
          </Link>
        ))}
      </nav>
    );
  }

  const primaryPages = workspacePages.filter((item) => ["overview", "repositories", "runs", "connect"].includes(item.id));
  const toolPages = workspacePages.filter((item) => ["request", "graph", "benchmarks"].includes(item.id));

  return (
    <nav aria-label="Workspace pages">
      {connected ? (
        <>
          <p className="px-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Workspace</p>
          <div className="mt-1 space-y-0.5">
            {primaryPages.map((item) => (
              <WorkspaceLink key={item.id} item={item} active={view === item.id} href={workspaceHref(item.id, runId)} status={item.id === "runs" ? String(runs.length) : undefined} />
            ))}
          </div>
          <p className="mt-5 px-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Tools</p>
          <div className="mt-1 space-y-0.5">
            {toolPages.map((item) => (
              <WorkspaceLink key={item.id} item={item} active={view === item.id} href={workspaceHref(item.id, runId)} />
            ))}
          </div>
        </>
      ) : (
        <OnboardingFlow active={view === "repository" ? 1 : 1} compact />
      )}

      {runId && connected ? (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 px-3">
            <p className="text-[10px] font-medium text-muted">Current run</p>
            <span className="max-w-24 truncate font-mono text-[8px] text-lexical" title={runId}>{runId}</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {runPages.map((item) => (
              <WorkspaceLink key={item.id} item={item} active={view === item.id} href={workspaceHref(item.id, runId)} />
            ))}
          </div>
        </div>
      ) : null}

      {connected && events.filter((event) => event.source === "mcp").length ? (
        <p className="mt-5 px-2 text-[10px] text-muted">{events.filter((event) => event.source === "mcp").length} agent calls recorded</p>
      ) : null}
    </nav>
  );
}

function OnboardingFlow({ active, compact = false }: { active: 1 | 2 | 3; compact?: boolean }) {
  const steps = [
    { number: 1, title: "Choose source", detail: "Demo or local repository" },
    { number: 2, title: "Run a preflight", detail: "Describe one code change" },
    { number: 3, title: "Connect an agent", detail: "Use the proven context" },
  ];
  return (
    <div className={compact ? "px-2" : "workspace-setup-flow"}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Setup</p>
      <ol className={`mt-3 ${compact ? "space-y-4" : "workspace-setup-steps"}`}>
        {steps.map((step) => (
          <li key={step.number} className={`grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 ${step.number < steps.length ? "workspace-setup-step" : ""}`}>
            <span className={`grid h-7 w-7 place-items-center rounded-full border font-mono text-[10px] ${step.number === active ? "border-[#7eb8d7] bg-[#e5f4fc] text-[#1f638b] shadow-[0_0_0_4px_rgb(126_184_215_/_0.12)]" : step.number < active ? "border-[#a9d6bc] bg-[#f1fbf5] text-[#287a52]" : "border-line bg-panel text-muted"}`}>{step.number < active ? "✓" : step.number}</span>
            <span>
              <span className={`block text-sm font-medium ${step.number === active ? "text-foreground" : step.number < active ? "text-[#287a52]" : "text-muted"}`}>{step.title}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WorkspaceLink({ item, active, href, status }: { item: { id: WorkspaceView; label: string; eyebrow: string }; active: boolean; href: string; status?: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group grid min-h-10 w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-100 ${focusRing} ${active ? "bg-[#dfeff8] text-[#173c54]" : "text-muted hover:bg-[#edf6fb] hover:text-foreground"}`}
    >
      <ViewGlyph view={item.id} active={active} />
      <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
      {status ? <span className="font-mono text-[9px] text-muted">{status}</span> : null}
    </Link>
  );
}

function ViewGlyph({ view, active, compact = false }: { view: WorkspaceView; active: boolean; compact?: boolean }) {
  const props = { size: compact ? 16 : 17, weight: active ? "bold" as const : "regular" as const };
  if (view === "welcome" || view === "overview") return <House {...props} />;
  if (view === "request") return <Plus {...props} />;
  if (view === "live") return <BracketsCurly {...props} />;
  if (view === "proof") return <Files {...props} />;
  if (view === "guard") return <ShieldCheck {...props} />;
  if (view === "runs") return <ClockCounterClockwise {...props} />;
  if (view === "graph") return <Graph {...props} />;
  if (view === "repository" || view === "repositories") return <Database {...props} />;
  if (view === "benchmarks") return <TrendUp {...props} />;
  return <PlugsConnected {...props} />;
}

function workspaceTitle(view: WorkspaceView, meta: Meta | null): string {
  const titles: Record<WorkspaceView, string> = {
    welcome: "Start",
    overview: sourceName(meta),
    request: "New preflight",
    live: "Run summary",
    proof: "Evidence",
    guard: "Patch Guard",
    runs: "Runs",
    graph: "Graph explorer",
    repository: "Repositories",
    repositories: "Repositories",
    connect: "Agent connection",
    benchmarks: "Benchmarks",
  };
  return titles[view];
}

const runLoopSteps: { id: WorkspaceView; label: string; number: number }[] = [
  { id: "live", label: "Preflight", number: 1 },
  { id: "proof", label: "Evidence", number: 2 },
  { id: "guard", label: "Verify patch", number: 3 },
];

function RunLoopStepper({ view, runId }: { view: WorkspaceView; runId: string }) {
  const order = runLoopSteps.map((step) => step.id);
  const currentIndex = order.indexOf(view);

  return (
    <nav className="run-loop hidden lg:flex" aria-label="Run workflow">
      {runLoopSteps.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <Link
            key={step.id}
            href={workspaceHref(step.id, runId)}
            aria-current={state === "current" ? "step" : undefined}
            className={`run-loop-step run-loop-step-${state} ${focusRing}`}
          >
            <span className="grid h-5 w-5 place-items-center rounded-full bg-white/80 font-mono text-[9px]">
              {state === "done" ? "✓" : step.number}
            </span>
            {step.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ProofPathPanel({ file, onInspect }: { file: RankedFile | undefined; onInspect: () => void }) {
  if (!file) return null;
  const hasEvidence = file.evidence.length > 0;

  return (
    <section className="proof-path-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">
            {hasEvidence ? "Graph proof path" : "Top text match"}
          </p>
          <h2 className="mt-2 break-all font-mono text-base font-semibold sm:text-lg">{file.path}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{file.why[0] ?? "Ranked for this change"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {file.bm25Rank ? <Badge>word rank #{file.bm25Rank}</Badge> : <Badge tone="accent">word search missed</Badge>}
            <Badge>{relationLabel(file.evidence[0])}</Badge>
          </div>
        </div>
        <button type="button" onClick={onInspect} className={`${buttonBase} shrink-0 border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>
          See full evidence
        </button>
      </div>
      {hasEvidence ? (
        <ol className="relative mt-5 space-y-4 before:absolute before:bottom-2 before:left-[0.85rem] before:top-2 before:w-px before:bg-[#b7d8e9]">
          {file.evidence.slice(0, 4).map((item, index) => (
            <li key={`${item.reached}-${index}`} className="relative grid grid-cols-[1.7rem_minmax(0,1fr)] gap-3">
              <span className={`relative z-10 grid h-7 w-7 place-items-center rounded-full border font-mono text-[9px] ${index === 0 ? "border-accent bg-[#fff7f1] text-accent" : "border-[#9fcce3] bg-[#f3fbff] text-lexical"}`}>{index + 1}</span>
              <div>
                <p className="text-sm font-semibold">{relationLabel(item)}</p>
                <p className="mt-1 break-all font-mono text-[10px] leading-5 text-muted">{item.via}{item.relTypes.length ? ` → ${item.relTypes.join(" → ")}` : ""} → {item.reached}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-4 rounded-xl border border-[#efc0a6] bg-[#fff8f3] p-4 text-sm leading-6 text-muted">
          Lumos could not verify a graph path to this file. Treat it as a text-search suggestion and refine the request if needed.
        </p>
      )}
    </section>
  );
}

function InlinePatchGuard({
  retrieve,
  onExpand,
  onVerified,
}: {
  retrieve: RetrieveResult;
  onExpand: () => void;
  onVerified: () => void;
}) {
  const [changedFiles, setChangedFiles] = useState(retrieve.ranked[0]?.path ?? "");
  const [testsRun, setTestsRun] = useState(retrieve.tests[0]?.qualname ?? "");
  const [verification, setVerification] = useState<PatchVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setVerifyError(null);
    try {
      const response = await fetch(`${API}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: retrieve.runId,
          changedFiles: changedFiles.split("\n").map((value) => value.trim()).filter(Boolean),
          testsRun: testsRun.split("\n").map((value) => value.trim()).filter(Boolean),
        }),
      });
      const body = (await response.json()) as PatchVerification & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "patch could not be verified");
      setVerification(body);
      onVerified();
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "patch could not be verified");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="inline-guard mt-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Patch Guard</p>
          <h2 className="mt-1 text-lg font-semibold">Verify the agent&apos;s edit before you merge</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Paste changed files and tests from the patch. Lumos checks scope against this preflight.</p>
        </div>
        <button type="button" onClick={onExpand} className={`${buttonBase} min-h-9 border border-line bg-panel px-3 text-xs text-foreground hover:border-lexical/60 ${focusRing}`}>
          Full Patch Guard
        </button>
      </div>

      {verification ? (
        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold capitalize">{verification.status === "ready" ? "Ready to review" : verification.status}</p>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{verification.summary}</p>
          </div>
          <div className={`grid h-14 w-14 place-items-center rounded-full border bg-panel font-mono text-xl font-semibold ${verification.status === "ready" ? "border-[#8ecbab] text-[#287a52]" : verification.status === "blocked" ? "border-[#efb38f] text-accent" : "border-[#9ccbe5] text-lexical"}`}>{verification.score}</div>
        </div>
      ) : (
        <form onSubmit={(event) => void verify(event)} className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <label className="block">
            <span className="text-xs font-semibold">Changed files</span>
            <textarea value={changedFiles} onChange={(event) => setChangedFiles(event.target.value)} rows={3} spellCheck={false} className={`mt-2 w-full resize-y rounded-xl border border-line bg-inset px-3 py-2 font-mono text-[11px] leading-5 hover:border-[#9cc5dc] ${focusRing}`} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold">Tests run</span>
            <textarea value={testsRun} onChange={(event) => setTestsRun(event.target.value)} rows={3} spellCheck={false} className={`mt-2 w-full resize-y rounded-xl border border-line bg-inset px-3 py-2 font-mono text-[11px] leading-5 hover:border-[#9cc5dc] ${focusRing}`} />
          </label>
          <div className="flex flex-col gap-2">
            {verifyError ? <p role="alert" className="rounded-lg border border-[#efc0a6] bg-[#fff8f3] px-3 py-2 text-xs text-accent">{verifyError}</p> : null}
            <button type="submit" disabled={busy || !changedFiles.trim()} aria-busy={busy} className={`${buttonBase} w-full bg-accent text-white hover:bg-[#a94d23] lg:min-w-36 ${focusRing}`}>
              {busy ? "Checking…" : "Run Patch Guard"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function RunContext({ view, request, retrieve }: { view: WorkspaceView; request: string; retrieve: RetrieveResult }) {
  const quality = retrieve.quality ?? {
    filesChecked: 0,
    filesSelected: retrieve.ranked.length,
    graphEvidenceFiles: retrieve.ranked.filter((file) => file.evidence.length > 0).length,
    testsFound: retrieve.tests.length,
    mode: "text-only" as const,
  };
  return (
    <section className="shrink-0 border-b border-line bg-panel" aria-label="Current run">
      <div className="flex min-h-11 items-center gap-3 px-4 lg:px-6">
        <span className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_4px_rgb(198_95_44_/_0.1)]" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={request}>{request}</p>
        <div className="hidden shrink-0 items-center gap-4 font-mono text-[10px] text-muted sm:flex">
          <span>{fmt(quality.filesChecked)} checked</span><span>{quality.filesSelected} selected</span><span>{quality.testsFound} tests</span>
        </div>
      </div>
      <nav className="flex overflow-x-auto px-2 sm:px-4 lg:hidden" aria-label="Run pages">
        {runPages.map((page) => (
          <Link key={page.id} href={workspaceHref(page.id, retrieve.runId)} aria-current={view === page.id ? "page" : undefined} className={`relative flex min-h-11 min-w-28 items-center justify-center px-3 text-xs font-semibold ${focusRing} ${view === page.id ? "text-lexical" : "text-muted"}`}>
            {page.label}{view === page.id ? <span className="absolute inset-x-3 bottom-0 h-0.5 bg-lexical" /> : null}
          </Link>
        ))}
      </nav>
      <RunLoopStepper view={view} runId={retrieve.runId} />
    </section>
  );
}

function WelcomeView({
  meta,
  graphReady,
  onDemo,
  onRepository,
}: {
  meta: Meta | null;
  graphReady: boolean;
  onDemo: () => void;
  onRepository: () => void;
}) {
  return (
    <div className="welcome-stage mx-auto flex min-h-full w-full max-w-[1180px] items-start px-5 py-10 sm:px-8 lg:items-center lg:py-14">
      <div className="welcome-grid w-full">
        <section className="welcome-copy">
          <p className="workspace-kicker">Context before code</p>
          <h1 className="mt-4 text-[2.35rem] font-semibold leading-[1.05] tracking-[-0.045em] sm:text-[2.85rem]">
            Give your agent the right files.
          </h1>
          <p className="mt-4 max-w-md text-base leading-7 text-muted">
            Lumos proves which files and tests matter before an AI edits your repository.
          </p>

          <div className="mt-8 hidden lg:block">
            <OnboardingFlow active={1} />
          </div>

          <div className="mt-8 lg:hidden">
            <OnboardingFlow active={1} compact />
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
            <p className="inline-flex items-center gap-2">
              <ShieldCheck size={15} className="text-[#287a52]" /> No model key required
            </p>
            <p className="inline-flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${graphReady ? "bg-[#2f9e68]" : "bg-accent"}`} />
              {graphReady ? `Graph indexed · ${fmt(meta?.files ?? 0)} searchable files` : meta?.serviceReady ? "Active repository needs indexing" : "Start HydraDB to index"}
            </p>
          </div>
        </section>

        <section className="welcome-actions">
          <div className="source-picker">
            <button type="button" onClick={onDemo} className={`source-card source-card-demo group ${focusRing}`}>
              <span className="source-card-icon" aria-hidden="true">
                <Bug size={22} weight="duotone" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">Try Lumos on Django</span>
                  <span className="source-card-badge">Included demo</span>
                  {meta?.serviceReady ? <span className="source-card-live">Live</span> : null}
                </span>
                <span className="mt-1.5 block text-sm leading-6 text-muted">
                  Run a real bug through ranked files, graph proof, and connected tests.
                </span>
                <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-lexical group-hover:text-[#123b55]">
                  Open workspace <ArrowRight size={14} className="transition-transform duration-100 group-hover:translate-x-0.5" />
                </span>
              </span>
            </button>

            <button type="button" onClick={onRepository} className={`source-card group ${focusRing}`}>
              <span className="source-card-icon source-card-icon-local" aria-hidden="true">
                <TerminalWindow size={22} weight="duotone" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[15px] font-semibold">Use your own repository</span>
                <span className="mt-1.5 block text-sm leading-6 text-muted">
                  Index a repo on your machine and make it the active workspace. Python and TypeScript supported.
                </span>
                <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-lexical group-hover:text-[#123b55]">
                  Set up source <ArrowRight size={14} className="transition-transform duration-100 group-hover:translate-x-0.5" />
                </span>
              </span>
            </button>
          </div>

          <div className="welcome-footnote">
            <p>Pick a source, run a preflight, then connect Cursor so the agent calls Lumos before it edits.</p>
            <Link href="/app/connect" className={`inline-flex items-center gap-1.5 font-semibold text-lexical hover:text-foreground ${focusRing}`}>
              Skip to agent setup <ArrowRight size={13} />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function OverviewView({
  meta,
  runs,
  events,
  repositories,
  graphReady,
  serviceReady,
  onNew,
  onOpenRun,
  onKillerDemo,
}: {
  meta: Meta | null;
  runs: RunSummary[];
  events: ActivityEvent[];
  repositories: RepositoryRecord[];
  graphReady: boolean;
  serviceReady: boolean;
  onNew: () => void;
  onOpenRun: (id: string) => void;
  onKillerDemo: () => void;
}) {
  const mcpEvents = events.filter((event) => event.source === "mcp");
  const activeRepository = repositories.find((repository) => repository.active);
  const isSampleRepository = Boolean(meta?.sample || activeRepository?.source === "sample");
  const setupProgress = [Boolean(meta?.files), runs.length > 0, mcpEvents.length > 0];

  return (
    <div className="dashboard-home mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
      <header className="dashboard-intro relative min-h-[9rem] overflow-hidden pr-0 sm:pr-56">
        <p className="text-sm text-muted">Active repository · {sourceName(meta)}</p>
        <h1 className="mt-3 max-w-3xl text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.045em] sm:text-[2.65rem]">
          {graphReady ? "Your codebase graph is indexed." : "Your files are visible. The graph still needs indexing."}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">
          {graphReady
            ? meta?.testFiles === 0
              ? "Symbols and relationships are available. No test files were detected, so connected-test suggestions will stay empty until tests are added."
              : "Lumos can now prove the smallest useful context and suggest connected tests before an agent edits."
            : "Browse the source now, then index this repository into HydraDB before running a preflight."}
        </p>
        <Image src="/assets/lumos-graph-core-transparent.png" alt="" width={448} height={448} className="dashboard-core-art" />
      </header>

      <dl className="dashboard-metric-grid mt-7">
        <DashboardMetric icon={<Files size={21} />} value={fmt(meta?.files ?? 0)} label="Searchable files" detail={activeRepository?.source === "github" ? "Imported from GitHub" : sourceName(meta)} tone="blue" />
        <DashboardMetric icon={<ClockCounterClockwise size={21} />} value={fmt(runs.length)} label="Saved preflights" detail={runs.length ? "Evidence ready to reopen" : "Run your first preflight"} tone="green" />
        <DashboardMetric icon={<PlugsConnected size={21} />} value={fmt(mcpEvents.length)} label="Agent tool calls" detail={mcpEvents.length ? "Recorded through MCP" : "No agent connected yet"} tone="orange" />
        <DashboardMetric icon={<Graph size={21} />} value={graphReady ? "Indexed" : serviceReady ? "Not indexed" : "Offline"} label="HydraDB graph" detail={graphReady ? `${fmt(meta?.testFiles ?? 0)} test files detected` : serviceReady ? "Index this repository" : "Start the graph service"} tone="violet" />
      </dl>

      {isSampleRepository ? <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1.45fr)]">
        <section className="dashboard-card relative p-6 sm:p-7">
          <h2 className="text-base font-semibold">Get started</h2>
          <p className="mt-1 text-sm text-muted">Three steps from source to agent-ready proof.</p>
          <ol className="setup-timeline mt-7">
            {[
              ["Choose source", activeRepository?.slug ?? meta?.repo ?? "Demo or GitHub repository"],
              ["Run a preflight", runs.length ? `${runs.length} saved ${runs.length === 1 ? "run" : "runs"}` : "Describe one concrete change"],
              ["Connect an agent", mcpEvents.length ? `${mcpEvents.length} recorded tool calls` : "Use the proven context through MCP"],
            ].map(([title, detail], index) => (
              <li key={title} className={setupProgress[index] ? "is-complete" : ""}>
                <span className="setup-timeline-number">{setupProgress[index] ? "✓" : index + 1}</span>
                <span><strong>{title}</strong><small>{detail}</small></span>
              </li>
            ))}
          </ol>
          <div className="mt-7 flex flex-wrap gap-3">
            <button type="button" disabled={!graphReady} onClick={onNew} className={`${buttonBase} gap-2 bg-[#176a9b] text-white hover:bg-[#12577f] ${focusRing}`}>New preflight <ArrowRight size={15} /></button>
            <Link href="/app/connect" className={`inline-flex min-h-10 items-center gap-2 px-2 text-sm font-semibold text-lexical hover:text-foreground ${focusRing}`}>Agent setup <ArrowRight size={14} /></Link>
          </div>
        </section>

        <section className="dashboard-card relative p-6 sm:p-7">
          <h2 className="text-base font-semibold">Quick start</h2>
          <p className="mt-1 text-sm text-muted">Explore the proof case or bring in a public codebase.</p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <button type="button" disabled={!serviceReady} onClick={onKillerDemo} className={`quickstart-card group text-left ${focusRing}`}>
              <span className="quickstart-icon quickstart-icon-blue"><Bug size={20} /></span>
              <span className="quickstart-badge">Included proof case</span>
              <strong>Try Lumos on Django</strong>
              <small>See where word search ranks the patch third and HydraDB proves it first.</small>
              <span className="quickstart-link">Open proof case <ArrowRight size={14} /></span>
            </button>
            <Link href="/app/repository" className={`quickstart-card group ${focusRing}`}>
              <span className="quickstart-icon quickstart-icon-orange"><GithubLogo size={20} /></span>
              <span className="quickstart-badge quickstart-badge-live">Live import</span>
              <strong>Use your own repository</strong>
              <small>Import a public GitHub repository, index it, and inspect the source here.</small>
              <span className="quickstart-link">Set up source <ArrowRight size={14} /></span>
            </Link>
          </div>
          <div className="dashboard-tip mt-5"><span>Tip</span> Start with the demo to understand the loop, then switch to your repository.</div>
        </section>
      </div> : null}

      <div className="mt-7 grid gap-6 xl:grid-cols-2">
        <section className="dashboard-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-6 py-5">
            <div><h2 className="text-base font-semibold">Recent preflights</h2><p className="mt-1 text-sm text-muted">Latest evidence packages for this workspace.</p></div>
            <Link href="/app/runs" className={`inline-flex items-center gap-1.5 text-xs font-semibold text-lexical hover:text-foreground ${focusRing}`}>View all <ArrowRight size={13} /></Link>
          </div>
          {runs.length ? <ul className="border-t border-line px-4">{runs.slice(0, 4).map((run) => <li key={run.id} className="border-b border-line last:border-0"><button type="button" onClick={() => onOpenRun(run.id)} className={`group grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-4 text-left hover:bg-[#f3f9fc] ${focusRing}`}><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#edf6fb] text-lexical"><BracketsCurly size={17} /></span><span className="min-w-0"><strong className="block truncate text-sm font-medium">{compactRequest(run.request)}</strong><small className="mt-1 block text-xs text-muted">{run.quality.filesChecked} searched → {run.quality.filesSelected} selected · {run.quality.testsFound} tests</small></span><time className="text-[11px] text-muted">{timeAgo(run.completedAt)}</time></button></li>)}</ul> : <div className="border-t border-line px-6 py-10 text-center"><p className="text-sm font-medium">No preflights yet</p><p className="mt-1 text-sm text-muted">Describe one change to create the first evidence package.</p></div>}
        </section>

        <section className="dashboard-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-6 py-5">
            <div><h2 className="text-base font-semibold">Connected agents</h2><p className="mt-1 text-sm text-muted">Tools that can request this repository context.</p></div>
            <Link href="/app/connect" className={`inline-flex items-center gap-1.5 text-xs font-semibold text-lexical hover:text-foreground ${focusRing}`}>Manage <ArrowRight size={13} /></Link>
          </div>
          <ul className="border-t border-line px-5 py-2">
            {["Cursor", "Codex", "Claude Code"].map((agent) => {
              const connected = mcpEvents.some((event) => event.summary.toLowerCase().includes(agent.toLowerCase())) || mcpEvents.length > 0;
              return <li key={agent} className="flex items-center gap-3 border-b border-line py-3.5 last:border-0"><span className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel font-mono text-xs font-semibold">{agent.slice(0, 1)}</span><span className="min-w-0 flex-1"><strong className="block text-sm font-medium">{agent}</strong><small className="text-xs text-muted">MCP context tools</small></span><span className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${connected ? "bg-[#e8f8ef] text-[#287a52]" : "bg-[#f1f5f7] text-muted"}`}>{connected ? "Connected" : "Available"}</span></li>;
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function DashboardMetric({ icon, value, label, detail, tone }: { icon: React.ReactNode; value: string; label: string; detail: string; tone: "blue" | "green" | "orange" | "violet" }) {
  return (
    <div className="dashboard-metric">
      <span className={`dashboard-metric-icon dashboard-metric-${tone}`}>{icon}</span>
      <span><dd className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{value}</dd><dt className="mt-0.5 text-xs font-medium text-muted">{label}</dt><small className="mt-1 block text-[11px] text-[#8296a3]">{detail}</small></span>
    </div>
  );
}

function LiveRunView({
  retrieve,
  request,
  contract,
  contractJson,
  markdown,
  digest,
  copied,
  events,
  onCopy,
  onDownload,
  onRequest,
  onProof,
  onGuard,
  onVerified,
}: {
  retrieve: RetrieveResult | null;
  request: string;
  contract: ContextContract | null;
  contractJson: string;
  markdown: string;
  digest: string;
  copied: CopyTarget;
  events: ActivityEvent[];
  onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void>;
  onDownload: () => void;
  onRequest: () => void;
  onProof: () => void;
  onGuard: () => void;
  onVerified: () => void;
}) {
  if (!retrieve) return <EmptyView number="01" eyebrow="Live run" title="No preflight is running yet." body="Start with a concrete code change. Lumos will show each repository and graph step here, then prepare the context your agent receives." action="Preflight a change" onAction={onRequest} />;

  const proof = retrieve.quality.mode === "text-only" ? "text-only" : "graph-proved";
  const firstTarget = contract?.targets[0];
  const runEvents = events.filter((event) => event.runId === retrieve.runId || event.source === "mcp").slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-[1380px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full border px-3 py-1 font-mono text-[10px] ${proof === "graph-proved" ? "border-[#a9d6bc] bg-[#f1fbf5] text-[#287a52]" : "border-[#efc0a6] bg-[#fff8f3] text-accent"}`}>{proof === "graph-proved" ? "graph-proved" : "text-only"}</span>
          </div>
          <h1 className="mt-3 max-w-4xl text-3xl font-semibold tracking-[-0.035em]">Preflight ready</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">{request}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onProof} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Inspect proof</button>
          <button type="button" onClick={onGuard} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Verify the patch <span className="ml-2" aria-hidden="true">→</span></button>
        </div>
      </div>

      <dl className="mt-7 grid overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-4">
        <ProofMetric label="Repository searched" value={fmt(retrieve.quality.filesChecked)} detail="indexed files" />
        <ProofMetric label="Context selected" value={String(retrieve.quality.filesSelected)} detail="files for the agent" />
        <ProofMetric label="Graph paths" value={fmt(retrieve.traversal.pathCount)} detail={retrieve.traversal.engine} tone="accent" />
        <ProofMetric label="Tests found" value={String(retrieve.quality.testsFound)} detail="connected guards" />
      </dl>

      <ProofPathPanel file={retrieve.ranked[0]} onInspect={onProof} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(25rem,0.9fr)_minmax(30rem,1.1fr)]">
        <section className="rounded-xl border border-line bg-panel p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Execution trace</p>
              <h2 className="mt-1 text-xl font-semibold">What Lumos actually did</h2>
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted">{retrieve.elapsedMs} ms</span>
          </div>
          <ol className="relative mt-5 space-y-0 before:absolute before:bottom-6 before:left-[0.86rem] before:top-4 before:w-px before:bg-[#b7d8e9]">
            {retrieve.trace.map((step, index) => (
              <li key={step.id} className="relative grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 pb-5">
                <span className={`relative z-10 grid h-7 w-7 place-items-center rounded-full border font-mono text-[9px] ${index === retrieve.trace.length - 1 ? "border-accent bg-[#fff7f1] text-accent" : "border-[#9fcce3] bg-[#f3fbff] text-lexical"}`}>✓</span>
                <span>
                  <span className="block text-sm font-semibold">{step.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted">{step.detail}</span>
                </span>
                <span className="font-mono text-[9px] tabular-nums text-muted">{step.elapsedMs}ms</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-xl border border-[#abd4e8] bg-[#eef9ff] p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Context contract</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">What the coding agent receives</h2>
            </div>
            <button type="button" disabled={!contract} onClick={() => void onCopy(markdown, "markdown")} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>{copied === "markdown" ? "Brief copied" : "Copy agent brief"}</button>
          </div>
          {firstTarget ? (
            <div className="mt-6 rounded-2xl border border-[#efc0a6] bg-[#fff8f3] p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-accent">Start here</p>
                <span className="font-mono text-[9px] text-muted">word rank {firstTarget.wordRank ? `#${firstTarget.wordRank}` : "missed"} → Lumos #1</span>
              </div>
              <p className="mt-2 break-all font-mono text-sm font-semibold">{firstTarget.path}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{firstTarget.reason}</p>
            </div>
          ) : <p className="mt-6 text-sm text-muted">No graph-backed contract is available for this run.</p>}
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Next files</p>
              <ol className="mt-2 divide-y divide-[#c7deeb] border-y border-[#c7deeb]">
                {contract?.targets.slice(1, 5).map((target) => <li key={target.path} className="break-all py-2.5 font-mono text-[10px] leading-5">{target.path}</li>)}
              </ol>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Tests to run</p>
              {contract?.tests.length ? <ul className="mt-2 divide-y divide-[#c7deeb] border-y border-[#c7deeb]">
                {contract.tests.slice(0, 4).map((test) => <li key={test.symbol} className="break-all py-2.5 font-mono text-[10px] leading-5">{test.symbol}</li>)}
              </ul> : <p className="mt-2 text-sm leading-6 text-muted">{retrieve.quality.testFilesDetected === 0 ? "No test files were detected in this repository." : "No connected tests were found for this change."}</p>}
            </div>
          </div>
          <div className="mt-5 flex items-start gap-3 border-t border-[#c7deeb] pt-4">
            <span className="font-mono text-[9px] text-muted">SHA-256</span>
            <code className="min-w-0 break-all font-mono text-[9px] leading-5 text-[#315a75]">{digest || "Calculating contract digest…"}</code>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={!contract} onClick={() => void onCopy(contractJson, "json")} className={`${buttonBase} min-h-10 border border-[#a8cee1] bg-panel px-3 text-foreground hover:border-lexical ${focusRing}`}>{copied === "json" ? "JSON copied" : "Copy contract JSON"}</button>
            <button type="button" disabled={!contract} onClick={onDownload} className={`${buttonBase} min-h-10 border border-[#a8cee1] bg-panel px-3 text-foreground hover:border-lexical ${focusRing}`}>Download contract</button>
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Agent exchange</p>
            <h2 className="mt-1 text-lg font-semibold">Tool activity tied to this workflow</h2>
          </div>
          <span className="font-mono text-[9px] text-muted">run {retrieve.runId}</span>
        </div>
        {runEvents.length ? <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{runEvents.map((event) => <li key={event.id} className="rounded-xl border border-line bg-inset p-3"><div className="flex items-center justify-between gap-3"><code className="font-mono text-[10px] font-semibold">{event.tool}</code><time className="font-mono text-[9px] text-muted">{timeAgo(event.at)}</time></div><p className="mt-2 text-xs leading-5 text-muted">{event.summary}</p></li>)}</ul> : <p className="mt-4 text-sm text-muted">This browser preflight is complete. Connect MCP to see your IDE agent calls appear here too.</p>}
      </section>

      <InlinePatchGuard retrieve={retrieve} onExpand={onGuard} onVerified={onVerified} />
    </div>
  );
}

function PatchGuardView({ retrieve, onRequest, onVerified }: { retrieve: RetrieveResult | null; onRequest: () => void; onVerified: () => void }) {
  const [changedFiles, setChangedFiles] = useState("");
  const [testsRun, setTestsRun] = useState("");
  const [verification, setVerification] = useState<PatchVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  if (!retrieve) return <EmptyView number="04" eyebrow="Patch Guard" title="Preflight before you verify." body="Patch Guard needs the graph-backed context from a run. Start a change, hand it to your agent, then return with the files and tests it touched." action="Preflight a change" onAction={onRequest} />;
  const runId = retrieve.runId;

  const loadSafeExample = () => {
    setChangedFiles(retrieve.ranked[0]?.path ?? "");
    setTestsRun(retrieve.tests[0]?.qualname ?? "");
    setVerification(null);
    setVerifyError(null);
  };

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setVerifyError(null);
    try {
      const response = await fetch(`${API}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          changedFiles: changedFiles.split("\n").map((value) => value.trim()).filter(Boolean),
          testsRun: testsRun.split("\n").map((value) => value.trim()).filter(Boolean),
        }),
      });
      const body = (await response.json()) as PatchVerification & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "patch could not be verified");
      setVerification(body);
      onVerified();
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "patch could not be verified");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="max-w-4xl">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">Verify the agent&apos;s patch</h1>
        <p className="mt-3 text-base leading-7 text-muted">Paste repository-relative paths from the patch and the tests the agent ran. Lumos compares them with preflight <code className="font-mono text-xs text-foreground">{retrieve.runId}</code>.</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(24rem,0.85fr)_minmax(30rem,1.15fr)]">
        <form onSubmit={(event) => void verify(event)} className="rounded-xl border border-line bg-panel p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <h2 className="text-xl font-semibold">Patch manifest</h2>
              <p className="mt-1 text-xs text-muted">One repository-relative path per line.</p>
            </div>
            <button type="button" onClick={loadSafeExample} className={`${buttonBase} min-h-10 border border-line bg-panel px-3 text-foreground hover:border-lexical/60 ${focusRing}`}>Load safe example</button>
          </div>
          <label htmlFor="changed-files" className="mt-5 block text-sm font-semibold">Changed files</label>
          <textarea id="changed-files" value={changedFiles} onChange={(event) => setChangedFiles(event.target.value)} rows={5} spellCheck={false} placeholder={retrieve.ranked[0]?.path ?? "src/path/to/file.py"} className={`mt-2 min-h-36 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 font-mono text-xs leading-6 placeholder:text-muted/60 hover:border-[#9cc5dc] ${focusRing}`} />
          <p className="mt-2 text-xs leading-5 text-muted">Lumos blocks the patch if the primary graph-backed target is missing.</p>
          <label htmlFor="tests-run" className="mt-5 block text-sm font-semibold">Tests reported by the agent</label>
          <textarea id="tests-run" value={testsRun} onChange={(event) => setTestsRun(event.target.value)} rows={4} spellCheck={false} placeholder={retrieve.tests[0]?.qualname ?? "tests.path.test_name"} className={`mt-2 min-h-28 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 font-mono text-xs leading-6 placeholder:text-muted/60 hover:border-[#9cc5dc] ${focusRing}`} />
          {verifyError ? <p role="alert" className="mt-3 rounded-xl border border-[#efc0a6] bg-[#fff8f3] p-3 text-sm text-accent">{verifyError} Check the run and try again.</p> : null}
          <button type="submit" disabled={busy || !changedFiles.trim()} aria-busy={busy} className={`${buttonBase} mt-5 w-full bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>{busy ? "Checking patch…" : "Run Patch Guard"}</button>
          <p className="mt-3 text-center text-xs text-muted">MCP agents can call <code className="font-mono text-[10px]">lumos.verify_patch</code> automatically.</p>
        </form>

        <section className="rounded-xl border border-[#b4d8ea] bg-[#eef9ff] p-5 sm:p-7" aria-live="polite">
          {verification ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Patch verdict</p>
                  <h2 className="mt-2 text-3xl font-semibold capitalize tracking-[-0.035em]">{verification.status === "ready" ? "Ready to review" : verification.status}</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{verification.summary}</p>
                </div>
                <div className={`grid h-20 w-20 place-items-center rounded-full border bg-panel font-mono text-2xl font-semibold tabular-nums ${verification.status === "ready" ? "border-[#8ecbab] text-[#287a52]" : verification.status === "blocked" ? "border-[#efb38f] text-accent" : "border-[#9ccbe5] text-lexical"}`}>{verification.score}</div>
              </div>
              <ol className="mt-7 divide-y divide-[#c7deeb] border-y border-[#c7deeb]">
                {verification.checks.map((check) => (
                  <li key={check.id} className="grid grid-cols-[1.8rem_minmax(0,1fr)] gap-3 py-4">
                    <span className={`grid h-7 w-7 place-items-center rounded-full border font-mono text-xs ${check.state === "pass" ? "border-[#8ecbab] bg-[#f1fbf5] text-[#287a52]" : check.state === "fail" ? "border-[#efb38f] bg-[#fff7f1] text-accent" : "border-[#9ccbe5] bg-panel text-lexical"}`}>{check.state === "pass" ? "✓" : check.state === "fail" ? "!" : "?"}</span>
                    <span><span className="block text-sm font-semibold">{check.title}</span><span className="mt-1 block text-sm leading-6 text-muted">{check.detail}</span></span>
                  </li>
                ))}
              </ol>
              <p className="mt-5 font-mono text-[9px] text-muted">Verified {new Date(verification.verifiedAt).toLocaleString()}</p>
            </>
          ) : (
            <div className="flex min-h-[34rem] flex-col justify-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl border border-[#9ccbe5] bg-panel font-mono text-lg text-lexical">✓</span>
              <p className="mt-6 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Waiting for a patch</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">Four checks, one clear verdict.</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted">Patch Guard checks the primary target, unexpected scope, connected tests, and whether the preflight itself carried graph evidence.</p>
              <dl className="mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#b6d9ea] bg-[#b6d9ea]">
                <CaseMetric label="Expected target" value={shortPath(retrieve.ranked[0]?.path ?? "None")} />
                <CaseMetric label="Connected tests" value={String(retrieve.tests.length)} />
              </dl>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RunsView({ runs, loading, currentRunId, onRefresh, onNew }: { runs: RunSummary[]; loading: boolean; currentRunId: string | null; onRefresh: () => void; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => `${run.id} ${run.request} ${run.repo}`.toLowerCase().includes(needle));
  }, [query, runs]);
  if (loading) return <ResultSkeleton />;
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.035em]">Preflights</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Reopen a request with its original ranking, graph path, tests, and agent handoff.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onRefresh} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical ${focusRing}`}>Refresh</button>
          <button type="button" onClick={onNew} className={`${buttonBase} gap-2 bg-foreground text-panel hover:bg-[#2a3540] ${focusRing}`}><Plus size={15} /> New preflight</button>
        </div>
      </div>
      {runs.length ? (
        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <label className="relative block w-full max-w-md" htmlFor="run-search">
              <span className="sr-only">Search saved runs</span>
              <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input id="run-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search requests, repositories, or run IDs" className={`min-h-10 w-full rounded-lg border border-line bg-panel py-2 pl-9 pr-4 text-sm placeholder:text-muted/70 hover:border-[#9cc5dc] ${focusRing}`} />
            </label>
            <p className="font-mono text-[10px] text-muted">{filteredRuns.length} of {runs.length} runs</p>
          </div>
          {filteredRuns.length ? (
        <ol className="mt-6 overflow-hidden rounded-xl border border-line bg-panel">
          {filteredRuns.map((run, index) => (
            <li key={run.id} className={index === filteredRuns.length - 1 ? "" : "border-b border-line"}>
              <Link href={workspaceHref("live", run.id)} className={`grid min-h-24 w-full gap-4 px-5 py-4 text-left transition-colors duration-100 hover:bg-inset sm:grid-cols-[7rem_minmax(0,1fr)_minmax(14rem,0.55fr)_auto] sm:items-center ${focusRing}`}>
                <span>
                  <span className="block font-mono text-[10px] text-muted">{new Date(run.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  <span className="mt-1 block font-mono text-[10px] text-muted">{new Date(run.completedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2"><span className="font-mono text-[9px] text-lexical">{run.id}</span>{run.id === currentRunId ? <Badge tone="accent">open</Badge> : null}</span>
                  <span className="mt-2 block truncate text-sm font-semibold">{compactRequest(run.request)}</span>
                  <span className="mt-1 block truncate text-xs text-muted">{run.repo}</span>
                </span>
                <span className="grid grid-cols-3 gap-3">
                  <SmallStat label="Checked" value={fmt(run.quality.filesChecked)} />
                  <SmallStat label="Selected" value={String(run.quality.filesSelected)} />
                  <SmallStat label="Tests" value={String(run.quality.testsFound)} />
                </span>
                <ArrowRight size={15} className="text-lexical" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
          ) : (
            <div className="mt-8 rounded-[1.6rem] border border-dashed border-line bg-panel p-10 text-center">
              <h2 className="text-xl font-semibold">No runs match “{query}”.</h2>
              <p className="mt-2 text-sm text-muted">Try a filename, repository name, or a shorter phrase.</p>
              <button type="button" onClick={() => setQuery("")} className={`${buttonBase} mt-5 border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Clear search</button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-8 rounded-[1.6rem] border border-dashed border-line bg-panel p-10 text-center">
          <h2 className="text-2xl font-semibold">No saved runs yet.</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">Your first preflight will appear here with the complete graph trace and context contract.</p>
          <button type="button" onClick={onNew} className={`${buttonBase} mt-6 bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Create the first run</button>
        </div>
      )}
    </div>
  );
}

function ConnectAgentView({
  meta,
  events,
  copied,
  onCopy,
}: {
  meta: Meta | null;
  events: ActivityEvent[];
  copied: CopyTarget;
  onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void>;
}) {
  const repository = meta?.repo ?? "owner/name";
  const setupCommand = `cd /absolute/path/to/lumos
pnpm lumos init /absolute/path/to/repository --slug ${repository}
pnpm lumos connect /absolute/path/to/repository`;
  const config = JSON.stringify({
    mcpServers: {
      lumos: {
        command: "pnpm",
        args: ["--dir", "/absolute/path/to/lumos", "mcp"],
        env: {
          LUMOS_REPO: repository,
          LUMOS_ROOT: "/absolute/path/to/repository",
        },
      },
    },
  }, null, 2);
  const mcpEvents = events.filter((event) => event.source === "mcp");
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="max-w-4xl">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">Connect your coding agent</h1>
        <p className="mt-2 text-sm leading-6 text-muted">Run the setup on the computer that owns your repository. The browser cannot write your local Cursor files.</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(30rem,1.1fr)_minmax(22rem,0.9fr)]">
        <section className="rounded-xl border border-line bg-panel p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Cursor</p>
              <h2 className="mt-2 text-xl font-semibold">Set up {sourceName(meta)} locally</h2>
            </div>
            <StatusPill ready={meta?.ready === true}>{meta?.ready ? "server ready" : "server offline"}</StatusPill>
          </div>
          <ol className="mt-5 space-y-4 text-sm leading-6 text-muted">
            <li><strong className="text-foreground">1.</strong> Keep HydraDB running locally.</li>
            <li><strong className="text-foreground">2.</strong> Run the commands below inside your local Lumos checkout.</li>
            <li><strong className="text-foreground">3.</strong> The agent will call <code className="font-mono text-xs text-foreground">lumos.preflight_change</code> before editing and <code className="font-mono text-xs text-foreground">lumos.verify_patch</code> after.</li>
          </ol>
          <button type="button" onClick={() => void onCopy(setupCommand, "config")} className={`${buttonBase} mt-6 bg-accent px-4 text-white hover:bg-[#a94d23] ${focusRing}`}>
            {copied === "config" ? "Setup commands copied" : "Copy local setup commands"}
          </button>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-inset p-4 font-mono text-[11px] leading-6"><code>{setupCommand}</code></pre>
          <div className="mt-6 overflow-hidden rounded-2xl border border-[#b8dbea] bg-[#eaf6fd]">
            <div className="flex items-center justify-between border-b border-[#b8dbea] px-4 py-3">
              <span className="font-mono text-[10px] text-[#315a75]">mcp.json</span>
              <button type="button" onClick={() => void onCopy(config, "json")} className={`min-h-10 rounded-lg border border-[#9ccbe5] bg-panel px-3 text-xs font-semibold text-foreground hover:border-lexical ${focusRing}`}>{copied === "json" ? "Configuration copied" : "Copy configuration"}</button>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6 text-[#173a55]"><code>{config}</code></pre>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted"><strong className="text-foreground">No OpenAI key is required.</strong> Lumos is the graph context layer used by the coding agent you already run.</p>
          <details className="mt-5 rounded-xl border border-line bg-inset p-4">
            <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Index your own repository</summary>
            <p className="mt-3 text-xs leading-5 text-muted">Python and TypeScript/JavaScript checkouts are supported. Replace both absolute path placeholders before running the commands.</p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-panel p-3 font-mono text-[10px] leading-5"><code>{`pnpm lumos init /path/to/repo --slug owner/name
pnpm lumos connect`}</code></pre>
          </details>
        </section>

        <div className="space-y-6">
          <section className="rounded-xl border border-[#b4d8ea] bg-[#eef9ff] p-5 sm:p-6">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Available tools</p>
            <ul className="mt-4 divide-y divide-[#c7deeb] border-y border-[#c7deeb]">
              {(meta?.mcpTools ?? ["lumos.preflight_change", "lumos.verify_patch", "lumos.explain_file_rank", "lumos.impact", "lumos.tests_for_change"]).map((tool, index) => (
                <li key={tool} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-3">
                  <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full font-mono text-[8px] ${index < 2 ? "bg-[#fff2e8] text-accent" : "bg-panel text-lexical"}`}>{index + 1}</span>
                  <code className="break-all font-mono text-[11px] font-semibold">{tool}</code>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-line bg-panel p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">MCP activity</h2>
              <span className="font-mono text-[9px] text-muted">{mcpEvents.length} calls</span>
            </div>
            {mcpEvents.length ? <ul className="mt-4 divide-y divide-line">{mcpEvents.slice(0, 5).map((event) => <li key={event.id} className="py-3"><div className="flex items-center justify-between gap-3"><code className="truncate font-mono text-[10px] font-semibold">{event.tool}</code><time className="font-mono text-[9px] text-muted">{timeAgo(event.at)}</time></div><p className="mt-1 truncate text-xs text-muted">{event.summary}</p></li>)}</ul> : <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-sm leading-6 text-muted">No IDE calls yet. Once connected, successful and failed tool calls appear here.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function RepositoryView({
  serviceReady,
  repositories,
  onDemo,
  onReady,
  copied,
  onCopy,
}: {
  serviceReady: boolean;
  repositories: RepositoryRecord[];
  onDemo: () => void;
  onReady: () => Promise<void>;
  copied: CopyTarget;
  onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void>;
}) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const completedJob = useRef<string | null>(null);
  const setup = `pnpm lumos init /absolute/path/to/repo --slug owner/name
pnpm lumos connect
pnpm api`;

  useEffect(() => {
    if (!job || !["queued", "cloning", "indexing"].includes(job.status)) return;
    const poll = window.setInterval(() => {
      void fetch(`${API}/repositories/import/${encodeURIComponent(job.id)}`)
        .then(async (response) => {
          const body = (await response.json()) as { job?: ImportJob; error?: string };
          if (!response.ok || !body.job) throw new Error(body.error ?? "Import status unavailable");
          setJob(body.job);
          if (body.job.status === "ready" && completedJob.current !== body.job.id) {
            completedJob.current = body.job.id;
            window.clearInterval(poll);
            await onReady();
          }
          if (body.job.status === "error") window.clearInterval(poll);
        })
        .catch((reason: unknown) => setImportError(reason instanceof Error ? reason.message : "Import status unavailable"));
    }, 1400);
    return () => window.clearInterval(poll);
  }, [job, onReady]);

  async function importRepository() {
    setImportBusy(true);
    setImportError(null);
    try {
      const response = await fetch(`${API}/repositories/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: repositoryUrl }),
      });
      const body = (await response.json()) as { job?: ImportJob; reused?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository import failed");
      if (body.reused) {
        await onReady();
        return;
      }
      if (!body.job) throw new Error("Import did not start");
      setJob(body.job);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : "Repository import failed");
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-[1180px] px-5 py-10 sm:px-8 lg:py-12">
      <header className="max-w-3xl">
        <p className="text-sm font-medium text-lexical">Add source code</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em]">Choose what Lumos should understand.</h1>
        <p className="mt-4 text-base leading-7 text-muted">Try the measured Django case immediately, import a public GitHub repository in the browser, or index a private checkout locally.</p>
      </header>

      <div className="mt-9 grid gap-5 lg:grid-cols-2">
        <section className="dashboard-card relative p-6 sm:p-7">
          <span className="quickstart-icon quickstart-icon-blue"><Bug size={21} /></span>
          <span className="quickstart-badge ml-3">Included proof case</span>
          <h2 className="mt-6 text-xl font-semibold">Explore the Django demo</h2>
          <p className="mt-2 text-sm leading-6 text-muted">Run a frozen SWE-bench bug and inspect ranked files, the HydraDB path, covering tests, and the agent handoff.</p>
          <button type="button" disabled={!serviceReady} onClick={onDemo} className={`${buttonBase} mt-6 gap-2 bg-[#176a9b] text-white hover:bg-[#12577f] ${focusRing}`}>Run the proof case <ArrowRight size={15} /></button>
        </section>

        <section className="dashboard-card relative p-6 sm:p-7">
          <div className="flex items-center gap-3"><span className="quickstart-icon quickstart-icon-orange"><GithubLogo size={21} /></span><span className="quickstart-badge quickstart-badge-live">Indexes on your Lumos server</span></div>
          <h2 className="mt-6 text-xl font-semibold">Import a public GitHub repository</h2>
          <p className="mt-2 text-sm leading-6 text-muted">Lumos clones the repository on the VM, extracts Python or TypeScript symbols, and builds its HydraDB relationships.</p>
          <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void importRepository(); }}>
            <label htmlFor="repository-url" className="text-xs font-medium text-foreground">Repository URL or owner/name</label>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <input id="repository-url" type="text" inputMode="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="github.com/owner/repository" autoComplete="url" autoCapitalize="none" spellCheck={false} aria-invalid={importError || job?.status === "error" ? true : undefined} aria-describedby={importError || job?.status === "error" ? "repository-import-error" : undefined} className={`h-11 min-w-0 flex-1 rounded-lg border border-line bg-background px-3.5 text-sm placeholder:text-[#91a3ae] hover:border-[#9bbdcc] ${focusRing}`} />
              <button type="submit" disabled={!serviceReady || importBusy || !repositoryUrl.trim()} aria-busy={importBusy} className={`${buttonBase} h-11 gap-2 bg-[#176a9b] text-white hover:bg-[#12577f] ${focusRing}`}>{importBusy ? "Starting…" : "Import repository"} <ArrowRight size={15} /></button>
            </div>
          </form>
          {job ? <div id={job.status === "error" ? "repository-import-error" : undefined} role={job.status === "error" ? "alert" : "status"} className={`mt-4 rounded-lg border px-4 py-3 text-sm ${job.status === "error" ? "border-[#efc0a6] bg-[#fff8f3]" : "border-[#b8dbea] bg-[#f2faff]"}`}><div className="flex items-center justify-between gap-3"><strong>{job.slug}</strong><span className="text-xs capitalize text-muted">{job.status}</span></div><p className="mt-1 text-xs text-muted">{job.error ?? job.message}</p>{["queued", "cloning", "indexing"].includes(job.status) ? <span className="import-progress mt-3"><i /></span> : null}{job.status === "error" ? <button type="button" disabled={importBusy} onClick={() => void importRepository()} className={`${buttonBase} mt-3 min-h-10 border border-[#efc0a6] bg-panel px-3 text-foreground ${focusRing}`}>Retry import</button> : null}</div> : null}
          {importError ? <p id="repository-import-error" role="alert" className="mt-3 text-sm text-accent">{importError}</p> : null}
        </section>
      </div>

      {repositories.length > 1 ? <section className="dashboard-card mt-5 p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Already indexed</h2><p className="mt-1 text-sm text-muted">Switch from the repository browser.</p></div><Link href="/app/repositories" className={`inline-flex items-center gap-2 text-sm font-semibold text-lexical ${focusRing}`}>View repositories <ArrowRight size={14} /></Link></div></section> : null}

      <details className="dashboard-card mt-5 p-6">
        <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Private or local repository</summary>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">Run the local indexer where the source already lives. Repository contents stay on that machine; Lumos only gives the agent the selected context package.</p>
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-[#eef6fb]"><div className="flex items-center justify-between border-b border-line px-4 py-2.5"><span className="font-mono text-[10px] text-muted">Terminal</span><button type="button" onClick={() => void onCopy(setup, "config")} className={`text-xs font-semibold text-muted hover:text-foreground ${focusRing}`}>{copied === "config" ? "Copied" : "Copy"}</button></div><pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6"><code>{setup}</code></pre></div>
        <p className="mt-4 flex items-start gap-2 text-xs text-muted"><ShieldCheck size={15} /> No AI model key is required. Lumos prepares context for the coding agent you already use.</p>
      </details>
    </div>
  );
}

function RepositoryBrowserView({ repositories, meta, graphReady, onActivate, onRefresh }: { repositories: RepositoryRecord[]; meta: Meta | null; graphReady: boolean; onActivate: (slug: string) => void; onRefresh: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [matched, setMatched] = useState(0);
  const [languages, setLanguages] = useState<{ language: string; files: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetch(`${API}/files?limit=220&q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as { files?: string[]; matched?: number; languages?: { language: string; files: number }[]; error?: string };
          if (!response.ok) throw new Error(body.error ?? "Indexed files unavailable");
          setFiles(body.files ?? []);
          setMatched(body.matched ?? 0);
          setLanguages(body.languages ?? []);
          setSelected((current) => current && body.files?.includes(current) ? current : body.files?.[0] ?? null);
          if (!body.files?.length) setSource(null);
          setFileError(null);
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setFileError(reason instanceof Error ? reason.message : "Indexed files unavailable");
        })
        .finally(() => setLoading(false));
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [meta?.repo, query]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void fetch(`${API}/file?path=${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { content?: string; truncated?: boolean; error?: string };
        if (!response.ok) throw new Error(body.error ?? "File preview unavailable");
        setSource(body.content ?? "");
        setTruncated(Boolean(body.truncated));
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setFileError(reason instanceof Error ? reason.message : "File preview unavailable");
      });
    return () => controller.abort();
  }, [selected]);

  return <div className="repository-browser mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-8 lg:px-10">
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-medium text-lexical">Repository workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Browse what Lumos indexed.</h1><p className="mt-2 text-sm text-muted">Search the complete indexed file set, inspect source, or switch repositories.</p></div><div className="flex gap-2"><button type="button" onClick={onRefresh} className={`${buttonBase} border border-line bg-panel px-3.5 text-foreground ${focusRing}`}>Refresh</button><Link href="/app/repository" className={`${buttonBase} gap-2 bg-[#176a9b] text-white hover:bg-[#12577f] ${focusRing}`}><Plus size={15} /> Add repository</Link></div></header>

    <section className="mt-7 flex gap-3 overflow-x-auto pb-2" aria-label="Repositories">{repositories.map((repository) => <button key={repository.slug} type="button" disabled={repository.active || repository.status !== "ready"} onClick={() => onActivate(repository.slug)} title={repositoryStatus(repository)} className={`min-w-[13.5rem] rounded-xl border p-4 text-left ${repository.active ? "border-[#8fc6e1] bg-[#edf8fd]" : "border-line bg-panel hover:border-[#9bc8dc]"} ${focusRing}`}><div className="flex items-center justify-between gap-3"><GithubLogo size={17} className="text-lexical" /><span className={`h-1.5 w-1.5 rounded-full ${repository.graphReady ? "bg-[#2f9e68]" : repository.status === "error" ? "bg-accent" : "border border-[#aec3cf]"}`} /></div><strong className="mt-3 block truncate text-sm">{repository.label}</strong><small className="mt-1 block truncate text-xs text-muted">{repositoryStatus(repository)}</small></button>)}</section>

    <div className="repository-browser-shell mt-5">
      <aside className="repository-file-pane">
        <div className="border-b border-line p-4"><div className="relative"><MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search indexed files" className={`h-10 w-full rounded-lg border border-line bg-background pl-9 pr-3 text-sm ${focusRing}`} /></div><div className="mt-3 flex flex-wrap gap-1.5">{languages.slice(0, 4).map((item) => <span key={item.language} className="rounded-full bg-[#edf6fb] px-2 py-1 text-[10px] text-[#4b6f83]">{item.language} · {item.files}</span>)}</div></div>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[10px] text-muted"><span>{loading ? "Loading…" : `${fmt(matched)} matches`}</span><span>{fmt(meta?.files ?? 0)} indexed</span></div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">{files.map((path) => <li key={path}><button type="button" onClick={() => setSelected(path)} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left font-mono text-[11px] ${selected === path ? "bg-[#e5f3fa] text-[#155f89]" : "text-[#4f6674] hover:bg-[#f0f6f9]"} ${focusRing}`}><Files size={14} className="shrink-0" /><span className="truncate">{path}</span></button></li>)}</ul>
      </aside>
      <section className="repository-source-pane"><div className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4"><p className="truncate font-mono text-xs font-semibold">{selected ?? "Select a file"}</p>{selected ? <Link href={`/app/new`} className={`text-xs font-semibold text-lexical ${focusRing}`}>Preflight a change <ArrowRight size={12} className="inline" /></Link> : null}</div>{fileError ? <div className="p-6 text-sm text-accent">{fileError}</div> : source !== null ? <div className="source-code-view" aria-label={`Source preview for ${selected}`}>{source.split("\n").map((line, index) => <div key={index} className="source-code-line"><span>{index + 1}</span><code>{line || " "}</code></div>)}{truncated ? <p className="p-4 text-xs text-muted">Preview truncated at 200 KB.</p> : null}</div> : <div className="grid min-h-[28rem] place-items-center p-8 text-center"><div><Files size={25} className="mx-auto text-lexical" /><p className="mt-3 text-sm font-medium">Choose an indexed file</p><p className="mt-1 text-sm text-muted">Its source will appear here.</p></div></div>}</section>
    </div>
    {!graphReady ? <p className="mt-4 text-xs text-accent">The active repository has no graph index yet. File browsing remains available.</p> : null}
  </div>;
}

function GraphExplorerView({
  repo,
  impact,
  graphNodes,
  graphLinks,
  selectedNode,
  graphReady,
  busy,
  onWalk,
  onSelect,
}: {
  repo: string;
  impact: ImpactResult | null;
  graphNodes: GraphNode[];
  graphLinks: GraphLink[];
  selectedNode: string | null;
  graphReady: boolean;
  busy: boolean;
  onWalk: (symbol: string) => void;
  onSelect: (node: string) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [suggestions, setSuggestions] = useState<{ qualname: string; path: string; kind: string }[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo || !graphReady) return;
    const controller = new AbortController();
    void fetch(`${API}/symbols?limit=6`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { symbols?: { qualname: string; path: string; kind: string }[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Repository symbols unavailable");
        const next = body.symbols ?? [];
        setSuggestionError(null);
        setSuggestions(next);
        setSymbol(next[0]?.qualname ?? "");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setSuggestionError(reason instanceof Error ? reason.message : "Repository symbols unavailable");
      });
    return () => controller.abort();
  }, [graphReady, repo]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-line bg-panel px-5 py-5 sm:px-7">
        <div className="mx-auto w-full max-w-[1280px]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.025em]">Graph explorer</h1>
              <p className="mt-1 text-sm text-muted">Follow calls and covering tests from a symbol in {repo || "the active repository"}.</p>
            </div>
            <form className="flex w-full max-w-2xl gap-2" onSubmit={(event) => { event.preventDefault(); onWalk(symbol.trim()); }}>
              <label className="sr-only" htmlFor="graph-symbol">Repository symbol</label>
              <div className="relative min-w-0 flex-1">
                <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input id="graph-symbol" type="search" value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="package.module.symbol" autoComplete="off" spellCheck={false} className={`h-10 w-full rounded-lg border border-line bg-background pl-9 pr-3 font-mono text-xs text-foreground placeholder:text-muted hover:border-[#aebfc9] ${focusRing}`} />
              </div>
              <button type="submit" disabled={!graphReady || busy || !symbol.trim()} className={`${buttonBase} bg-foreground text-panel hover:bg-[#2a3540] ${focusRing}`}>{busy ? "Walking" : "Trace"}</button>
            </form>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {suggestions.map((item) => <button key={item.qualname} type="button" title={`${item.qualname} · ${item.path}`} onClick={() => { setSymbol(item.qualname); onWalk(item.qualname); }} className={`min-h-10 rounded-md border border-line bg-background px-3 py-2 font-mono text-[10px] text-muted hover:border-lexical hover:text-foreground ${focusRing}`}>{item.qualname.split(".").at(-1)}</button>)}
          </div>
          {suggestionError ? <p role="alert" className="mt-3 text-xs text-accent">{suggestionError}</p> : null}
          {graphReady && !suggestionError && suggestions.length === 0 ? <p className="mt-3 text-xs text-muted">No repository symbols are available yet.</p> : null}
        </div>
      </div>

      {impact ? (
        <section className="flex min-h-[36rem] flex-1 flex-col" aria-label="Repository graph">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-background px-5 py-3 sm:px-7">
            <p className="truncate font-mono text-xs font-semibold">{impact.seed.qualname}</p>
            <p className="font-mono text-[10px] text-muted">{impact.symbols.length} symbols · {impact.tests.length} tests · {impact.pathCount} paths · {impact.elapsedMs} ms</p>
          </div>
          <div className="min-h-[32rem] flex-1">
            <BlastGraph seed={impact.seed.qualname} nodes={graphNodes} links={graphLinks} selected={selectedNode} onSelect={onSelect} />
          </div>
        </section>
      ) : (
        <div className="grid flex-1 place-items-center px-6 py-16">
          <div className="max-w-md text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-line bg-panel text-lexical"><Graph size={23} /></span>
            <h2 className="mt-5 text-lg font-semibold">Trace a symbol through the repository</h2>
            <p className="mt-2 text-sm leading-6 text-muted">Lumos will draw the actual HydraDB relationships and show the tests reached by the walk.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestView({
  issue,
  setIssue,
  requestError,
  issueRef,
  graphReady,
  busy,
  retrieve,
  meta,
  onRun,
  onDemo,
  onProof,
}: {
  issue: string;
  setIssue: (value: string) => void;
  requestError: string | null;
  issueRef: React.RefObject<HTMLTextAreaElement | null>;
  graphReady: boolean;
  busy: boolean;
  retrieve: RetrieveResult | null;
  meta: Meta | null;
  onRun: (value: string) => void;
  onDemo: () => void;
  onProof: () => void;
}) {
  const [repositoryExampleState, setRepositoryExampleState] = useState<{
    repo: string;
    examples: { label: string; value: string }[];
  }>({ repo: "", examples: [] });

  useEffect(() => {
    if (!graphReady || !meta?.repo || meta.sample) {
      return;
    }
    const controller = new AbortController();
    void fetch(`${API}/symbols?limit=3`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return [];
        const body = (await response.json()) as { symbols?: { qualname: string; path: string }[] };
        return (body.symbols ?? []).map((symbol) => ({
          label: symbol.qualname.split(".").at(-1) ?? symbol.qualname,
          value: `Update \`${symbol.qualname}\` and verify the behavior connected to ${symbol.path}.`,
        }));
      })
      .then((examples) => setRepositoryExampleState({ repo: meta.repo, examples }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setRepositoryExampleState({ repo: meta.repo, examples: [] });
        }
      });
    return () => controller.abort();
  }, [graphReady, meta?.repo, meta?.sample]);

  const demoExamples = [
    { label: "Template bug", value: SAMPLE_ISSUE },
    { label: "Rate limiting", value: "Add rate limiting to the payment endpoint and update its tests." },
    { label: "Validation error", value: "A ValueError escapes from URL validation instead of returning ValidationError." },
  ];
  const repositoryExamples = repositoryExampleState.repo === meta?.repo ? repositoryExampleState.examples : [];
  const examples = meta?.sample ? demoExamples : repositoryExamples;

  return (
    <div className="mx-auto min-h-full w-full max-w-[860px] px-5 py-10 sm:px-8 lg:py-14">
      <section>
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">What should the agent change?</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">Lumos checks all {fmt(meta?.files ?? 0)} indexed files and returns the smallest plan it can prove.</p>

        {examples.length > 0 ? <div className="mt-6 flex flex-wrap gap-2" aria-label={meta?.sample ? "Demo requests" : "Requests using repository symbols"}>
          {examples.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => {
                setIssue(example.value);
                window.setTimeout(() => issueRef.current?.focus(), 0);
              }}
              className={`min-h-8 rounded-md border border-line bg-panel px-3 text-xs font-medium text-muted hover:border-lexical hover:text-foreground ${focusRing}`}
            >
              {example.label}
            </button>
          ))}
        </div> : null}

        {graphReady && meta?.testFiles === 0 ? <p className="mt-4 rounded-lg border border-[#efcfaa] bg-[#fff9f2] px-4 py-3 text-sm leading-6 text-[#8b4b24]">No test files were detected in this repository. Lumos can still trace symbols and code relationships, but connected-test suggestions will remain empty.</p> : null}

        <form
          className="mt-4 rounded-xl border border-[#b9cbd5] bg-panel p-3 shadow-[0_10px_30px_rgb(18_40_54_/_0.06)] sm:p-4"
          onSubmit={(event) => {
            event.preventDefault();
            onRun(issue);
          }}
        >
          <label htmlFor="agent-request" className="sr-only">Change request</label>
          <textarea
            ref={issueRef}
            id="agent-request"
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onRun(issue);
              }
            }}
            rows={7}
            aria-invalid={requestError ? true : undefined}
            aria-describedby={requestError ? "request-error" : "request-help"}
            placeholder={meta?.sample ? "Example: The join template filter escapes its separator when autoescape is off." : "Describe the change and name a repository function, class, file, or stack trace when possible."}
            className={`min-h-52 w-full resize-y rounded-lg border bg-background px-4 py-4 text-sm leading-7 text-foreground placeholder:text-muted/70 hover:border-[#9cc5dc] ${requestError ? "border-accent" : "border-line"} ${focusRing}`}
          />
          {requestError ? <p id="request-error" role="alert" className="px-1 pt-2 text-sm leading-6 text-accent">{requestError}</p> : <p id="request-help" className="px-1 pt-2 text-xs leading-5 text-muted">A useful request names the behavior, error, feature, function, or stack trace involved.</p>}
          <div className="flex flex-col gap-3 px-1 pb-1 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted"><kbd className="rounded border border-line bg-inset px-1.5 py-1 font-mono text-[10px]">⌘ Enter</kbd> to run</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" disabled={busy || !graphReady} onClick={onDemo} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical ${focusRing}`}>
                Run included bug
              </button>
              <button type="submit" disabled={busy || !issue.trim() || !graphReady} className={`${buttonBase} min-w-40 gap-2 bg-foreground text-panel hover:bg-[#2a3540] ${focusRing}`}>
                {busy ? "Checking repository..." : <>Build preflight <ArrowRight size={15} /></>}
              </button>
            </div>
          </div>
        </form>

        {retrieve ? (
          <button type="button" onClick={onProof} className={`mt-4 inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-lexical hover:text-foreground ${focusRing}`}>
            Return to the latest plan <ArrowRight size={15} />
          </button>
        ) : null}
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-5 text-xs text-muted">
          <span>{fmt(meta?.files ?? 0)} files searched</span>
          <span>HydraDB {graphReady ? "indexed" : "offline"}</span>
          <span>{fmt(meta?.testFiles ?? 0)} test files detected</span>
          <span>No AI API key</span>
        </div>
      </section>
    </div>
  );
}

function ProofView({
  retrieve,
  busy,
  demo,
  gold,
  selectedFile,
  selectedRanked,
  lexicalRank,
  copied,
  graphReady,
  seedToWalk,
  fileRefs,
  onSelect,
  onCopy,
  onWalk,
  onRequest,
  onHandoff,
}: {
  retrieve: RetrieveResult | null;
  busy: boolean;
  demo: Demo | null;
  gold: string[];
  selectedFile: string | null;
  selectedRanked: RankedFile | null;
  lexicalRank: Map<string, number>;
  copied: boolean;
  graphReady: boolean;
  seedToWalk: string;
  fileRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  onSelect: (path: string) => void;
  onCopy: (path: string) => void;
  onWalk: () => void;
  onRequest: () => void;
  onHandoff: () => void;
}) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  if (busy && !retrieve) return <ResultSkeleton />;
  if (!retrieve) {
    return <EmptyView number="02" eyebrow="Edit plan" title="No edit plan yet." body="Describe one code change first. Lumos will check the repository, shortlist the files, and attach the tests and evidence behind them." action="Ask Lumos" onAction={onRequest} />;
  }

  const quality = retrieve.quality ?? {
    filesChecked: 0,
    filesSelected: retrieve.ranked.length,
    graphEvidenceFiles: retrieve.ranked.filter((file) => file.evidence.length > 0).length,
    testsFound: retrieve.tests.length,
    mode: "text-only" as const,
  };
  const topFile = retrieve.ranked[0];
  const topWordRank = topFile?.bm25Rank;
  const topHasEvidence = Boolean(topFile?.evidence.length);
  const visibleFiles = showAllFiles ? retrieve.ranked : retrieve.ranked.slice(0, 5);
  const hasVerifiedPlan = quality.graphEvidenceFiles > 0;
  const resultExplanation = topWordRank && topWordRank > 1 && topHasEvidence
    ? `Text search placed it #${topWordRank}. Connected repository evidence was strong enough to move it to #1.`
    : topWordRank === 1 && topHasEvidence
      ? `Text search found it first; the graph verified why it belongs and found ${quality.testsFound} connected tests.`
      : "This is a text-ranked suggestion. The graph did not verify it, so treat it as lower confidence.";

  return (
    <div className="min-h-full">
      <div className="border-b border-line px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-5">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-lexical">02 / Edit plan</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">{hasVerifiedPlan ? "Start with these files." : "Start with these text matches."}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{hasVerifiedPlan ? `Lumos checked ${fmt(quality.filesChecked)} files and narrowed this change to ${quality.filesSelected}. Open any file to see why it belongs and which tests protect it.` : `Lumos checked ${fmt(quality.filesChecked)} files and ranked ${quality.filesSelected} by the request text. Treat them as a starting list; the graph did not prove a path.`}</p>
          </div>
          <button type="button" onClick={onHandoff} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Create agent brief <span className="ml-2" aria-hidden="true">→</span></button>
        </div>
      </div>

      <div className="border-b border-line bg-panel px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-[1440px] gap-4 lg:grid-cols-[minmax(22rem,1.4fr)_minmax(30rem,1fr)] lg:items-center">
          <div>
            <p className="text-sm font-semibold text-muted">{hasVerifiedPlan ? "Best starting point" : "Unverified text candidate"}</p>
            <p className="mt-1 break-all font-mono text-base font-semibold">{topFile?.path ?? "No file selected"}</p>
            <p className="mt-2 text-sm leading-6 text-muted">{resultExplanation}</p>
          </div>
          <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-inset sm:grid-cols-4">
            <ProofMetric label="Checked" value={fmt(quality.filesChecked)} detail="whole repository" />
            <ProofMetric label="Selected" value={String(quality.filesSelected)} detail="strongest matches" />
            <ProofMetric label={hasVerifiedPlan ? "Start here" : "Verified start"} value={hasVerifiedPlan ? "#1" : "None"} detail={hasVerifiedPlan ? shortPath(topFile?.path ?? "None") : "refine request"} tone="accent" />
            <ProofMetric label="Tests" value={String(quality.testsFound)} detail="connected" />
          </dl>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1440px] lg:grid-cols-[minmax(24rem,0.9fr)_minmax(25rem,1.1fr)]">
        <section className="border-line px-4 py-6 sm:px-6 lg:border-r lg:px-8" aria-labelledby="ranked-files-title">
          <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <h2 id="ranked-files-title" className="text-lg font-semibold">{hasVerifiedPlan ? "Files to review" : "Unverified text matches"}</h2>
              <p className="mt-1 text-xs text-muted">{hasVerifiedPlan ? "Ordered for this change. Use ↑ ↓ or J K to inspect." : "Shown for investigation only; Lumos did not verify these through the graph."}</p>
            </div>
            <span className="rounded-full border border-line bg-panel px-3 py-1.5 font-mono text-[10px] text-muted">{retrieve.ranked.length} files</span>
          </div>
          {demo ? <p className="border-b border-line py-3 text-xs leading-5 text-muted">Proof case <span className="font-mono text-foreground">{demo.id}</span>. The known patch target is marked.</p> : null}
          <ol>
            {visibleFiles.map((file, index) => {
              const active = selectedFile === file.path;
              const isGold = gold.includes(file.path);
              const wordRank = lexicalRank.get(file.path);
              const delta = wordRank === undefined ? null : wordRank - (index + 1);
              return (
                <li key={file.path} className="border-b border-line">
                  <button
                    type="button"
                    ref={(node) => {
                      if (node) fileRefs.current.set(file.path, node);
                      else fileRefs.current.delete(file.path);
                    }}
                    onClick={() => onSelect(file.path)}
                    className={`my-2 grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-3 rounded-2xl border p-3 text-left transition-colors duration-150 sm:p-4 ${focusRing} ${active ? "border-[#efb693] bg-[#fff7f1] shadow-[0_8px_28px_rgb(178_83_37_/_0.08)]" : "border-transparent hover:border-[#add3e7] hover:bg-panel"}`}
                  >
                    <span className={`font-mono text-sm tabular-nums ${active ? "text-accent" : "text-muted"}`}>{String(index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0">
                      <span className="block break-words font-mono text-[13px] font-semibold text-foreground">{file.path}</span>
                      <span className="mt-1.5 block text-sm leading-5 text-muted">{file.why[0] ?? "Ranked by request context"}</span>
                      <span className="mt-3 flex flex-wrap gap-1.5">
                        {isGold ? <Badge tone="accent">patch target</Badge> : null}
                        <Badge>{relationLabel(file.evidence[0])}</Badge>
                        {wordRank === undefined ? <Badge tone="accent">word search missed</Badge> : null}
                        {delta !== null && delta > 0 ? <Badge tone="accent">promoted {delta}</Badge> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {retrieve.ranked.length > 5 ? (
            <button type="button" onClick={() => setShowAllFiles((value) => !value)} className={`${buttonBase} mt-4 w-full border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>
              {showAllFiles ? "Show fewer files" : `Show ${retrieve.ranked.length - 5} more files`}
            </button>
          ) : null}
        </section>

        <aside className="bg-panel px-4 py-6 sm:px-6 lg:px-8">
          {selectedRanked ? (
            <FileInspector
              file={selectedRanked}
              tests={retrieve.tests}
              traversal={retrieve.traversal}
              totalMs={retrieve.elapsedMs}
              withoutGraph={retrieve.withoutHydra}
              copied={copied}
              busy={busy}
              graphReady={graphReady}
              seedToWalk={seedToWalk}
              onCopy={() => onCopy(selectedRanked.path)}
              onWalk={onWalk}
            />
          ) : <InspectorEmpty />}
        </aside>
      </div>
    </div>
  );
}

function FileInspector({ file, tests, traversal, totalMs, withoutGraph, copied, busy, graphReady, seedToWalk, onCopy, onWalk }: {
  file: RankedFile;
  tests: TestHit[];
  traversal: RetrieveResult["traversal"];
  totalMs: number;
  withoutGraph: string[];
  copied: boolean;
  busy: boolean;
  graphReady: boolean;
  seedToWalk: string;
  onCopy: () => void;
  onWalk: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-lexical">Selected file</p>
        <h2 className="mt-2 break-all font-mono text-base font-semibold leading-7">{file.path}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onCopy} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>{copied ? "Path copied" : "Copy path"}</button>
          {seedToWalk ? <button type="button" disabled={busy || !graphReady} onClick={onWalk} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>See repository connections</button> : null}
        </div>
      </div>

      <section>
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
          <h3 className="text-sm font-semibold">Why Lumos recommends it</h3>
          <span className="font-mono text-[10px] text-muted">{file.evidence.length} graph links</span>
        </div>
        {file.evidence.length ? (
          <ol className="relative mt-5 space-y-5 before:absolute before:bottom-3 before:left-[0.85rem] before:top-3 before:w-px before:bg-[#b7d8e9]">
            {file.evidence.slice(0, 5).map((item, index) => (
              <li key={`${item.reached}-${index}`} className="relative grid grid-cols-[1.7rem_minmax(0,1fr)] gap-3">
                <span className={`relative z-10 grid h-7 w-7 place-items-center rounded-full border font-mono text-[9px] ${index === 0 ? "border-accent bg-[#fff7f1] text-accent" : "border-[#9fcce3] bg-[#f3fbff] text-lexical"}`}>{index + 1}</span>
                <div className="pb-1">
                  <p className="text-sm font-semibold">{relationLabel(item)}</p>
                  <p className="mt-1 break-all font-mono text-[11px] leading-5 text-muted">{item.via}{item.relTypes.length ? ` / ${item.relTypes.join(" → ")}` : ""} / {item.reached}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="mt-4 rounded-xl border border-line bg-inset p-4 text-sm leading-6 text-muted">Lumos could not verify this file through the repository graph. It remains a text-search suggestion, so treat it as lower confidence.</p>}
      </section>

      <div className="grid grid-cols-2 rounded-2xl border border-line bg-inset p-4">
        <MetricBlock label="Text search alone" value={file.bm25Rank ? `#${file.bm25Rank}` : "missed"} />
        <MetricBlock label="Graph evidence" value={file.evidence.length ? "verified" : "none"} accent={file.evidence.length > 0} />
      </div>

      <section>
        <h3 className="border-b border-line pb-3 text-sm font-semibold">Tests connected to this change</h3>
        {tests.length ? (
          <ul className="divide-y divide-line">
            {tests.slice(0, 8).map((test) => <li key={test.qualname} className="break-all py-3 font-mono text-xs leading-5">{test.qualname}</li>)}
          </ul>
        ) : <p className="py-4 text-sm text-muted">No covering tests were found from this walk.</p>}
      </section>

      <details className="rounded-2xl border border-line bg-inset p-4">
        <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Technical traversal</summary>
        <dl className="mt-4 space-y-2 border-t border-line pt-4 font-mono text-xs tabular-nums">
          <Row label="engine" value={traversal.engine} />
          <Row label="direction" value={`${traversal.direction} ${traversal.relTypes.join("+")}`} />
          <Row label="seeds" value={String(traversal.seedCount)} />
          <Row label="paths" value={fmt(traversal.pathCount)} />
          <Row label="walk" value={`${traversal.elapsedMs} ms`} />
          <Row label="total" value={`${totalMs} ms`} />
        </dl>
        {withoutGraph.length ? <ul className="mt-4 border-t border-line pt-4 text-sm text-muted">{withoutGraph.map((line) => <li key={line} className="mt-1">• {line}</li>)}</ul> : null}
      </details>
    </div>
  );
}

// Kept as the standalone contract renderer for future deep-link restoration.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function HandoffView({ contract, contractJson, markdown, digest, copied, onCopy, onDownload, onRequest }: {
  contract: ContextContract | null;
  contractJson: string;
  markdown: string;
  digest: string;
  copied: CopyTarget;
  onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void>;
  onDownload: () => void;
  onRequest: () => void;
}) {
  if (!contract) return <EmptyView number="03" eyebrow="Send to agent" title="No agent brief yet." body="Run a request first. Lumos will turn the shortlist, reasons, and connected tests into one clear starting plan for your coding agent." action="Ask Lumos" onAction={onRequest} />;

  const firstTarget = contract.targets[0];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-lexical">03 / Send to agent</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">Give your coding agent a clear starting plan.</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-muted">Copy one human-readable brief with the change, the files to inspect first, why they matter, and the tests to run.</p>
        </div>
        <button type="button" onClick={() => void onCopy(markdown, "markdown")} className={`${buttonBase} bg-accent px-5 text-white hover:bg-[#a94d23] ${focusRing}`}>{copied === "markdown" ? "Agent brief copied" : "Copy agent brief"}</button>
      </div>

      <div className="mt-9 grid gap-6 lg:grid-cols-[minmax(20rem,0.7fr)_minmax(28rem,1.3fr)]">
        <section className="rounded-[1.6rem] border border-line bg-panel p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3 border-b border-line pb-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">What your agent receives</p>
              <h2 className="mt-1 text-lg font-semibold">A focused edit plan</h2>
            </div>
            <span className="rounded-full border border-[#a9d6bc] bg-[#f1fbf5] px-3 py-1.5 font-mono text-[10px] text-[#287a52]">ready to copy</span>
          </div>
          <dl className="mt-5 grid grid-cols-3 gap-3">
            <MetricBlock label="Files" value={String(contract.targets.length)} />
            <MetricBlock label="Tests" value={String(contract.tests.length)} />
            <MetricBlock label="Proof paths" value={fmt(contract.traversal.pathCount)} />
          </dl>
          <p className="mt-6 border-l-2 border-lexical pl-4 text-sm leading-6 text-muted">This is the same result available through the browser, CLI, and MCP. No repository dump and no extra AI key.</p>
        </section>

        <section className="rounded-[1.6rem] border border-[#abd4e8] bg-[#eef9ff] p-5 shadow-[0_22px_60px_rgb(24_84_120_/_0.10)] sm:p-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Agent brief preview</p>
          <div className="mt-5 space-y-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Change</p>
              <p className="mt-2 text-base leading-7">{contract.request}</p>
            </div>
            {firstTarget ? (
              <div className="rounded-2xl border border-[#efc0a6] bg-[#fff8f3] p-4">
                <p className="text-xs font-semibold text-accent">Start here</p>
                <p className="mt-2 break-all font-mono text-sm font-semibold">{firstTarget.path}</p>
                <p className="mt-2 text-sm leading-6 text-muted">{firstTarget.reason}</p>
              </div>
            ) : null}
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Other files to inspect</p>
                <ol className="mt-2 divide-y divide-line border-y border-line">
                  {contract.targets.slice(1, 5).map((target) => <li key={target.path} className="break-all py-2.5 font-mono text-[11px] leading-5">{target.path}</li>)}
                </ol>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Tests to run</p>
                {contract.tests.length ? <ul className="mt-2 divide-y divide-line border-y border-line">{contract.tests.slice(0, 4).map((test) => <li key={test.symbol} className="break-all py-2.5 font-mono text-[11px] leading-5">{test.symbol}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No connected tests were found.</p>}
              </div>
            </div>
          </div>
        </section>
      </div>

      <details className="mt-6 rounded-[1.4rem] border border-line bg-panel p-5">
        <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Developer export (JSON + digest)</summary>
        <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-[minmax(14rem,0.45fr)_minmax(24rem,1.55fr)]">
          <div>
            <p className="text-sm leading-6 text-muted">Canonical ContextContractV1 for tools that need a stable, verifiable payload.</p>
            <p className="mt-5 font-mono text-[10px] text-muted">SHA-256 digest</p>
            <p className="mt-2 break-all font-mono text-[10px] leading-5">{digest || "Calculating…"}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void onCopy(contractJson, "json")} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>{copied === "json" ? "JSON copied" : "Copy JSON"}</button>
              <button type="button" onClick={onDownload} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Download JSON</button>
            </div>
          </div>
          <pre className="max-h-80 overflow-auto rounded-2xl border border-[#b8dbea] bg-[#eaf6fd] p-4 font-mono text-[10px] leading-5 text-[#173a55]"><code>{contractJson}</code></pre>
        </div>
      </details>
    </div>
  );
}

function BenchmarkView({ summary, cases, demo, onRefresh, onRunDemo, serviceReady }: { summary: EvalSummary | null; cases: EvalCase[]; demo: Demo | null; onRefresh: () => void; onRunDemo: () => void; serviceReady: boolean }) {
  const [filter, setFilter] = useState<"all" | EvalCase["outcome"]>("all");
  if (!summary) return <EmptyView number="EV" eyebrow="Measured retrieval" title="Benchmark data is unavailable." body="Start the Lumos API or run pnpm eval to produce the frozen comparison artifact." action="Retry" onAction={onRefresh} />;
  const visibleCases = filter === "all" ? cases : cases.filter((item) => item.outcome === filter);
  return (
    <div className="mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-8 lg:px-10 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-sm font-medium text-lexical">Frozen SWE-bench Lite evaluation</p>
          <h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.045em]">See exactly where the graph helps—and where it does not.</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">Text search builds the safe shortlist. HydraDB attaches call, coverage, and co-change proof, and only promotes a file when the relationship is corroborated.</p>
        </div>
        <div className="rounded-xl border border-line bg-panel px-4 py-3"><p className="text-xs text-muted">Reproduce locally</p><code className="mt-1 block font-mono text-xs font-semibold text-foreground">pnpm eval</code></div>
      </div>

      <section className="benchmark-method-grid mt-8" aria-label="Retrieval method comparison">
        <BenchmarkMethod label="BM25" role="Lexical baseline" at1={summary.methods.bm25.at1} at3={summary.methods.bm25.at3} note="Best current top-1 aggregate" />
        <BenchmarkMethod label="Graph only" role="HydraDB traversal" at1={summary.methods.graph.at1} at3={summary.methods.graph.at3} note="Evidence without lexical anchoring" />
        <BenchmarkMethod label="Lumos hybrid" role="Text shortlist + proof" at1={summary.methods.hybrid.at1} at3={summary.methods.hybrid.at3} note="Proof attached; guarded reorder" accent />
        <div className="benchmark-score-card benchmark-breakdown"><p className="text-xs font-medium text-muted">Hybrid vs BM25</p><div className="mt-5 grid grid-cols-3 gap-3"><span><strong>{summary.hybridVsBm25.improved}</strong><small>improved</small></span><span><strong>{summary.hybridVsBm25.hurt}</strong><small>hurt</small></span><span><strong>{summary.hybridVsBm25.tie}</strong><small>unchanged</small></span></div><p className="mt-5 text-xs leading-5 text-muted">{summary.n} frozen Django issues. No blanket accuracy claim.</p></div>
      </section>

      <section className="mt-6 rounded-2xl border border-[#afd7e9] bg-[#eef9ff] p-6 sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)] lg:items-center">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">A real case where names mislead</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">The correct edit was hidden behind a relationship.</h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">In Django bug 16873, text similarity ranked the eventual patch file third. A covering-test path connected the request to that file, so Lumos could put it first and show the evidence.</p>
            <button type="button" disabled={!serviceReady} onClick={onRunDemo} className={`${buttonBase} mt-6 gap-2 bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Open the disagreement case <ArrowRight size={15} /></button>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <span className="rounded-full border border-[#9bcde5] bg-panel px-3 py-1.5 font-mono text-[10px] text-lexical">{demo?.id ?? "django-16873"}</span>
            <dl className="grid w-full grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#b6d9ea] bg-[#b6d9ea] sm:grid-cols-4 lg:grid-cols-2">
              <CaseMetric label="Repository" value={`${fmt(demo?.files ?? 865)} files`} />
              <CaseMetric label="Text search" value="#3" />
              <CaseMetric label="Lumos" value="#1" accent />
              <CaseMetric label="Connected tests" value="20" />
            </dl>
          </div>
        </div>
      </section>

      <section className="dashboard-card mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4 sm:px-6"><div><h2 className="text-base font-semibold">Case explorer</h2><p className="mt-1 text-xs text-muted">Inspect every measured rank, including losses.</p></div><div className="flex gap-1 rounded-lg bg-[#eef5f8] p-1">{(["all", "improved", "hurt", "unchanged"] as const).map((value) => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${filter === value ? "bg-panel text-foreground shadow-sm" : "text-muted hover:text-foreground"} ${focusRing}`}>{value}</button>)}</div></div>
        <div className="overflow-x-auto"><table className="benchmark-table"><thead><tr><th>Issue</th><th>BM25 rank</th><th>Graph rank</th><th>Lumos rank</th><th>Outcome</th><th>Time</th></tr></thead><tbody>{visibleCases.slice(0, 40).map((item) => <tr key={item.instanceId}><td><span className="font-mono text-xs font-semibold">{item.instanceId.replace("django__django-", "django-")}</span><small>{item.goldFiles[0]}</small></td><td>{item.bm25 ? `#${item.bm25}` : "—"}</td><td>{item.graph ? `#${item.graph}` : "—"}</td><td className="font-semibold">{item.hybrid ? `#${item.hybrid}` : "—"}</td><td><span className={`benchmark-outcome benchmark-outcome-${item.outcome}`}>{item.outcome}</span></td><td>{item.retrieveMs} ms</td></tr>)}</tbody></table>{visibleCases.length > 40 ? <p className="border-t border-line px-6 py-3 text-xs text-muted">Showing 40 of {visibleCases.length} cases.</p> : null}</div>
      </section>

      <p className="mt-5 max-w-5xl text-xs leading-5 text-muted">Failure mode observed in this frozen run: {summary.failureMode} The current guarded retriever keeps BM25 as the default order and attaches graph proof even when it does not promote.</p>
    </div>
  );
}

function BenchmarkMethod({ label, role, at1, at3, note, accent = false }: { label: string; role: string; at1: number; at3: number; note: string; accent?: boolean }) {
  return <article className={`benchmark-score-card ${accent ? "is-accent" : ""}`}><div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{label}</h2><p className="mt-1 text-xs text-muted">{role}</p></div>{accent ? <span className="rounded-full bg-[#fff0e7] px-2 py-1 text-[10px] font-semibold text-accent">Product path</span> : null}</div><dl className="mt-6 grid grid-cols-2 gap-4"><div><dt>Top-1</dt><dd>{pct(at1)}</dd></div><div><dt>Top-3</dt><dd>{pct(at3)}</dd></div></dl><p className="mt-5 text-xs text-muted">{note}</p></article>;
}

function CaseMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="bg-panel p-4"><dt className="text-xs text-muted">{label}</dt><dd className={`mt-2 font-mono text-xl font-semibold ${accent ? "text-accent" : "text-foreground"}`}>{value}</dd></div>;
}

function EmptyView({ number, eyebrow, title, body, action, onAction }: { number: string; eyebrow: string; title: string; body: string; action: string; onAction: () => void }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <section className="w-full max-w-2xl rounded-[1.75rem] border border-[#b8dcec] bg-panel p-7 shadow-[0_22px_65px_rgb(36_112_158_/_0.09)] sm:p-10">
        <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-full border border-[#a8d1e6] bg-[#f0faff] font-mono text-xs text-lexical">{number}</span><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">{eyebrow}</p></div>
        <h1 className="mt-8 text-3xl font-semibold tracking-[-0.035em]">{title}</h1>
        <p className="mt-3 max-w-xl text-base leading-7 text-muted">{body}</p>
        <button type="button" onClick={onAction} className={`${buttonBase} mt-8 bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>{action}</button>
      </section>
    </div>
  );
}

function Notice({ tone, message, children }: { tone: "blue" | "orange"; message: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 text-sm lg:px-5 ${tone === "blue" ? "border-line bg-[#edf8ff] text-lexical" : "border-[#efc7b3] bg-[#fff7f1] text-accent"}`}>
      <p role={tone === "orange" ? "alert" : "status"}>{message}</p>{children}
    </div>
  );
}

function StatusPill({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  return <span className="inline-flex min-h-8 items-center gap-2 whitespace-nowrap font-mono text-[10px] text-muted"><span className={`h-2 w-2 rounded-full ${ready ? "bg-[#2f9e68]" : "bg-accent"}`} />{children}</span>;
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "accent" | "muted" }) {
  return <span className={`inline-flex min-h-6 items-center rounded-full border px-2 font-mono text-[9px] ${tone === "accent" ? "border-[#eeb899] bg-[#fff5ed] text-accent" : "border-line bg-panel text-muted"}`}>{children}</span>;
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="font-mono text-[9px] text-muted">{label}</dt><dd className="mt-1 truncate font-mono text-[11px] font-semibold">{value}</dd></div>;
}

function ProofMetric({ label, value, detail, tone = "muted" }: { label: string; value: string; detail: string; tone?: "accent" | "muted" }) {
  return <div className="border-b border-line px-4 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><p className="font-mono text-[9px] text-muted">{label}</p><p className={`mt-1 font-mono text-xl font-semibold ${tone === "accent" ? "text-accent" : "text-foreground"}`}>{value}</p><p className="mt-1 truncate text-xs text-muted">{detail}</p></div>;
}

function MetricBlock({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-0 border-r border-line px-3 last:border-r-0"><dt className="font-mono text-[9px] text-muted">{label}</dt><dd className={`mt-1 truncate font-mono text-lg font-semibold ${accent ? "text-accent" : "text-foreground"}`}>{value}</dd></div>;
}

function InspectorEmpty() {
  return <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-line p-6 text-center"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Proof inspector</p><h2 className="mt-2 text-lg font-semibold">Select a ranked file</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted">Its relationship path, rank change, and connected tests will appear here.</p></div></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd className="min-w-0 break-all text-right text-foreground">{value}</dd></div>;
}

function ResultSkeleton() {
  return <div className="mx-auto max-w-[1280px] space-y-4 p-6" aria-label="Tracing repository impact" role="status"><span className="sr-only">Tracing repository impact</span><div className="skel h-28 rounded-2xl" />{Array.from({ length: 5 }, (_, index) => <div key={index} className="skel h-20 rounded-2xl" />)}</div>;
}
