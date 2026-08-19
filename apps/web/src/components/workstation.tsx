"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BracketsCurly,
  Bug,
  ClockCounterClockwise,
  Database,
  Files,
  GitBranch,
  GitFork,
  Graph,
  House,
  MagnifyingGlass,
  PlugsConnected,
  Plus,
  ShieldCheck,
  TerminalWindow,
} from "@phosphor-icons/react";

import { BlastGraph, type GraphLink, type GraphNode } from "./blast-graph";

const API = process.env.NEXT_PUBLIC_LUMOS_API ?? "http://127.0.0.1:8787";

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
  repo: string;
  root: string;
  workspace: string;
  files: number;
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
  failureMode: string;
}

interface Demo {
  id: string;
  issue: string;
  gold: string[];
  note: string;
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
  | "connect";
type CopyTarget = "path" | "markdown" | "json" | "config" | null;

const workspacePages: { id: WorkspaceView; label: string; eyebrow: string }[] = [
  { id: "overview", label: "Home", eyebrow: "Django demo" },
  { id: "request", label: "New preflight", eyebrow: "Describe a change" },
  { id: "runs", label: "Runs", eyebrow: "Saved evidence" },
  { id: "graph", label: "Graph explorer", eyebrow: "Follow a symbol" },
  { id: "repositories", label: "Repositories", eyebrow: "Manage source code" },
  { id: "connect", label: "Agent connection", eyebrow: "MCP and CLI" },
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

const buttonBase =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-[background-color,border-color,color,transform] duration-100 active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

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
  if (!runId) return "/app/new";
  if (view === "proof") return `/app/runs/${encodeURIComponent(runId)}/proof`;
  if (view === "guard") return `/app/runs/${encodeURIComponent(runId)}/guard`;
  return `/app/runs/${encodeURIComponent(runId)}`;
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
  const [, setEvalSummary] = useState<EvalSummary | null>(null);
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
      setMeta((await response.json()) as Meta);
    } catch {
      setMeta(null);
    }
  }, []);

  const refreshEval = useCallback(async () => {
    try {
      const response = await fetch(`${API}/eval`);
      if (!response.ok) throw new Error("evaluation unavailable");
      setEvalSummary((await response.json()) as EvalSummary);
    } catch {
      setEvalSummary(null);
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

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshMeta(), refreshEval(), refreshRuns(), refreshEvents()]);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshEval, refreshEvents, refreshMeta, refreshRuns]);

  useEffect(() => {
    if (!initialRunId || retrieve?.runId === initialRunId) return;
    const controller = new AbortController();
    void fetch(`${API}/runs/${encodeURIComponent(initialRunId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as StoredRun & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "run could not be opened");
        const restored = { ...body.result, request: body.result.request || body.request };
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
    if (!retrieve || retrieve.quality?.mode === "text-only") return null;
    return {
      schema: "ContextContractV1",
      request: retrieve.request || activeRequest,
      repository: meta?.repo ?? "local repository",
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
      const restored = { ...body.result, request: body.result.request || body.request };
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
      const response = await fetch(`${API}/demo`);
      const body = (await response.json()) as Demo & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "demo failed");
      setDemo(body);
      setGold(body.gold);
      setIssue(SAMPLE_ISSUE);
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

  return (
    <div className="workstation-sky min-h-dvh overflow-hidden text-foreground">
      <div className="workstation-shell flex h-dvh overflow-hidden bg-background">
        <aside className="platform-sidebar hidden w-[16.5rem] shrink-0 flex-col border-r border-line lg:flex">
          <div className="mx-4 mt-5 flex items-center gap-3">
            <Link href="/" className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground ${focusRing}`} aria-label="Back to Lumos site"><ArrowLeft size={17} /></Link>
            <Link href="/app" className={`rounded-sm text-[15px] font-semibold tracking-[0.42em] text-foreground ${focusRing}`} aria-label="Lumos workspace home">LUMOS</Link>
          </div>
          <Link href={repositorySelected ? "/app/repositories" : "/app/repository"} className={`mx-3 mt-7 flex items-center gap-3 rounded-lg border border-[#c8dce7] bg-panel px-3 py-3 text-left hover:border-[#8fbdd4] ${focusRing}`}>
            <span className="grid h-8 w-8 shrink-0 place-items-center text-lexical"><GitFork size={19} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{repositorySelected ? "Django demo" : "Choose repository"}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">{repositorySelected ? `${fmt(meta?.files ?? 0)} indexed files` : "No source selected"}</span>
            </span>
          </Link>
          <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <WorkspaceNav view={view} runId={currentRunId} runs={runs} events={events} connected={repositorySelected} />
          </div>
        </aside>

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {repositorySelected ? <header className="platform-topbar flex min-h-14 shrink-0 items-center justify-between border-b border-line px-4 lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/" className={`grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground lg:hidden ${focusRing}`} aria-label="Back to Lumos site"><ArrowLeft size={16} /></Link>
              <Link href="/app" className={`text-[13px] font-semibold tracking-[0.32em] lg:hidden ${focusRing}`}>LUMOS</Link>
              <span className="hidden h-4 w-px bg-line sm:block lg:hidden" />
              <p className="hidden truncate text-sm font-medium text-foreground sm:block">{workspaceTitle(view)}</p>
            </div>
            <div className="flex items-center gap-3">
              {repositorySelected ? <span className="hidden md:block"><StatusPill ready={graphReady}>{graphReady ? "Graph ready" : "Graph offline"}</StatusPill></span> : null}
              {repositorySelected && view !== "request" ? (
                <Link href="/app/new" className={`${buttonBase} gap-2 bg-foreground px-3.5 text-panel hover:bg-[#2a3540] ${focusRing}`}>
                  <Plus size={15} weight="bold" /> <span className="sm:hidden">New</span><span className="hidden sm:inline">New preflight</span>
                </Link>
              ) : null}
            </div>
          </header> : (
            <header className="platform-topbar flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 lg:hidden">
              <Link href="/" className={`grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-inset hover:text-foreground ${focusRing}`} aria-label="Back to Lumos site"><ArrowLeft size={16} /></Link>
              <Link href="/app" className={`text-[13px] font-semibold tracking-[0.32em] ${focusRing}`}>LUMOS</Link>
            </header>
          )}

          {!graphReady && repositorySelected ? (
            <Notice tone="blue" message={<>HydraDB is offline. Start it with <code className="font-mono font-semibold text-foreground">pnpm db:up</code>.</>}>
              <button type="button" onClick={() => void refreshMeta()} className={`${buttonBase} min-h-8 border border-line bg-panel px-3 text-foreground ${focusRing}`}>Retry</button>
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
                <WelcomeView graphReady={graphReady} onDemo={() => navigate("overview")} onRepository={() => navigate("repository")} />
              ) : null}
              {view === "overview" ? (
                <OverviewView
                  meta={meta}
                  runs={runs}
                  graphReady={graphReady}
                  onNew={() => navigate("request")}
                  onOpenRun={(id) => void openRun(id)}
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
                <ConnectAgentView meta={meta} events={events} copied={copied} onCopy={copyText} />
              ) : null}
              {view === "repository" || view === "repositories" ? (
                <RepositoryView connected={view === "repositories"} meta={meta} graphReady={graphReady} onDemo={() => navigate("overview")} copied={copied} onCopy={copyText} />
              ) : null}
              {view === "graph" ? (
                <GraphExplorerView
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
    const mobilePages = workspacePages.slice(0, 4);
    return (
      <nav className="grid grid-cols-4 px-2" aria-label="Workspace pages">
        {mobilePages.map((item) => (
          <Link
            key={item.id}
            href={workspaceHref(item.id, runId)}
            aria-current={view === item.id ? "page" : undefined}
            className={`relative flex min-h-12 min-w-0 items-center justify-center gap-2 px-1 text-center text-[11px] font-semibold sm:text-xs ${focusRing} ${view === item.id ? "text-foreground" : "text-muted"}`}
          >
            <ViewGlyph view={item.id} active={view === item.id} compact />
            {item.label}
            {view === item.id ? <span className="absolute inset-x-5 bottom-0 h-0.5 bg-accent" /> : null}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Workspace pages">
      {connected ? (
        <>
          <p className="px-2 text-[10px] font-medium text-muted">Workspace</p>
          <div className="mt-1 space-y-0.5">
            {workspacePages.slice(0, 3).map((item) => (
              <WorkspaceLink key={item.id} item={item} active={view === item.id} href={workspaceHref(item.id, runId)} status={item.id === "runs" ? String(runs.length) : undefined} />
            ))}
          </div>
          <p className="mt-5 px-2 text-[10px] font-medium text-muted">Analyze</p>
          <div className="mt-1 space-y-0.5">
            <WorkspaceLink item={workspacePages[3]} active={view === "graph"} href={workspaceHref("graph", runId)} />
          </div>
        </>
      ) : (
        <OnboardingFlow active={view === "repository" ? 1 : 1} />
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

      {connected ? <div className="mt-5">
        <p className="px-2 text-[10px] font-medium text-muted">Setup</p>
        <div className="mt-1 space-y-0.5">
          <WorkspaceLink item={workspacePages[4]} active={view === "repositories"} href={workspaceHref("repositories", runId)} />
          <WorkspaceLink
            item={workspacePages[5]}
            active={view === "connect"}
            href={workspaceHref("connect", runId)}
            status={`${events.filter((event) => event.source === "mcp").length} calls`}
          />
        </div>
      </div> : null}
    </nav>
  );
}

function OnboardingFlow({ active }: { active: 1 | 2 | 3 }) {
  const steps = [
    { number: 1, title: "Choose source", detail: "Demo or local repository" },
    { number: 2, title: "Run a preflight", detail: "Describe one code change" },
    { number: 3, title: "Connect an agent", detail: "Use the proven context" },
  ];
  return (
    <div className="px-2">
      <p className="text-[10px] font-medium text-muted">Setup flow</p>
      <ol className="mt-3 space-y-4">
        {steps.map((step) => (
          <li key={step.number} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
            <span className={`grid h-7 w-7 place-items-center rounded-full border font-mono text-[10px] ${step.number === active ? "border-[#7eb8d7] bg-[#e5f4fc] text-[#1f638b]" : "border-line bg-panel text-muted"}`}>{step.number}</span>
            <span>
              <span className={`block text-sm font-medium ${step.number === active ? "text-foreground" : "text-muted"}`}>{step.title}</span>
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
  return <PlugsConnected {...props} />;
}

function workspaceTitle(view: WorkspaceView): string {
  const titles: Record<WorkspaceView, string> = {
    welcome: "Start",
    overview: "Django demo",
    request: "New preflight",
    live: "Run summary",
    proof: "Evidence",
    guard: "Patch Guard",
    runs: "Runs",
    graph: "Graph explorer",
    repository: "Repositories",
    repositories: "Repositories",
    connect: "Agent connection",
  };
  return titles[view];
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
    </section>
  );
}

function WelcomeView({ graphReady, onDemo, onRepository }: { graphReady: boolean; onDemo: () => void; onRepository: () => void }) {
  return (
    <div className="onboarding-surface mx-auto flex min-h-full w-full max-w-[1080px] items-start px-5 py-12 sm:px-10 lg:items-center lg:py-16">
      <section className="w-full">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-accent">Context before code</p>
          <h1 className="mt-3 text-[2.55rem] font-semibold leading-[1.06] tracking-[-0.045em] sm:text-5xl">Give your agent the right files.</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted">Lumos proves which files and tests matter before an AI edits your repository.</p>
        </div>

        <div className="mt-10 overflow-hidden rounded-xl border border-[#bdd7e6] bg-panel shadow-[0_18px_48px_rgb(31_99_139_/_0.07)]">
          <button type="button" onClick={onDemo} className={`group grid w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-[#d2e3ec] px-5 py-5 text-left hover:bg-[#eff8fd] ${focusRing}`}>
            <span className="grid h-11 w-11 place-items-center text-[#1f6e9b]"><Bug size={23} /></span>
            <span>
              <span className="flex items-center gap-2 text-sm font-semibold">Try Lumos on Django <span className={`h-1.5 w-1.5 rounded-full ${graphReady ? "bg-[#2f9e68]" : "bg-accent"}`} /></span>
              <span className="mt-1 block text-sm text-muted">Use a real bug to see ranked files, graph proof, and connected tests.</span>
            </span>
            <ArrowRight size={18} className="text-muted transition-transform duration-100 group-hover:translate-x-0.5" />
          </button>
          <button type="button" onClick={onRepository} className={`group grid w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-4 px-5 py-5 text-left hover:bg-[#eff8fd] ${focusRing}`}>
            <span className="grid h-11 w-11 place-items-center text-[#1f6e9b]"><TerminalWindow size={23} /></span>
            <span>
              <span className="block text-sm font-semibold">Use your own repository</span>
              <span className="mt-1 block text-sm text-muted">Index a local Python codebase and open its workspace.</span>
            </span>
            <ArrowRight size={18} className="text-muted transition-transform duration-100 group-hover:translate-x-0.5" />
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2"><ShieldCheck size={15} /> No model key is required.</p>
          <p>Choose a source, run a preflight, then connect your agent.</p>
        </div>
      </section>
    </div>
  );
}

function OverviewView({
  meta,
  runs,
  graphReady,
  onNew,
  onOpenRun,
}: {
  meta: Meta | null;
  runs: RunSummary[];
  graphReady: boolean;
  onNew: () => void;
  onOpenRun: (id: string) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[1160px] px-5 py-8 sm:px-8 lg:py-10">
      <section className="max-w-3xl">
        <div className="flex items-center gap-2 text-sm text-muted">
          <GitBranch size={16} /> <span>Django demo</span>
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">What are you changing?</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">Describe the change. Lumos searches all {fmt(meta?.files ?? 0)} files, follows the graph, and returns a small evidence-backed plan.</p>
        <button type="button" disabled={!graphReady} onClick={onNew} className={`mt-7 flex min-h-14 w-full max-w-2xl items-center justify-between rounded-xl border border-[#b9c9d2] bg-panel px-4 text-left shadow-[0_8px_22px_rgb(18_40_54_/_0.05)] hover:border-lexical ${focusRing}`}>
          <span className="flex items-center gap-3 text-sm text-muted"><MagnifyingGlass size={18} /> Describe a bug, feature, or stack trace</span>
          <span className="rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-panel">Start</span>
        </button>
      </section>

      <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.65fr)]">
        <section>
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-sm font-semibold">Recent preflights</h2>
            <Link href="/app/runs" className={`text-xs font-medium text-muted hover:text-foreground ${focusRing}`}>View all</Link>
          </div>
          {runs.length ? (
            <ul className="divide-y divide-line">
              {runs.slice(0, 5).map((run) => (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenRun(run.id)} className={`group grid w-full grid-cols-[1.8rem_minmax(0,1fr)_auto] items-start gap-3 py-4 text-left ${focusRing}`}>
                    <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-md bg-inset text-muted"><Files size={15} /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium group-hover:text-lexical">{compactRequest(run.request)}</span>
                      <span className="mt-1 block text-xs text-muted">{run.quality.filesSelected} files, {run.quality.testsFound} tests</span>
                    </span>
                    <time className="pt-1 text-xs text-muted" dateTime={run.completedAt}>{timeAgo(run.completedAt)}</time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-10 text-center">
              <p className="text-sm font-medium">No preflights yet</p>
              <p className="mt-1 text-sm text-muted">Your evidence-backed changes will appear here.</p>
            </div>
          )}
        </section>

        <aside className="border-l border-line pl-0 lg:pl-7">
          <h2 className="text-sm font-semibold">Repository</h2>
          <dl className="mt-4 space-y-4 text-sm">
            <Row label="Source" value="Django demo" />
            <Row label="Indexed files" value={fmt(meta?.files ?? 0)} />
            <Row label="Graph" value={graphReady ? "Ready" : "Offline"} />
            <Row label="Engine" value="HydraDB" />
          </dl>
          <Link href="/app/graph" className={`mt-6 inline-flex items-center gap-2 text-sm font-medium text-lexical hover:text-foreground ${focusRing}`}>Open graph explorer <ArrowRight size={15} /></Link>
        </aside>
      </div>
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
}) {
  if (!retrieve) return <EmptyView number="01" eyebrow="Live run" title="No preflight is running yet." body="Start with a concrete code change. Lumos will show each repository and graph step here, then prepare the context your agent receives." action="Preflight a change" onAction={onRequest} />;

  const ready = retrieve.quality.mode !== "text-only";
  const firstTarget = contract?.targets[0];
  const runEvents = events.filter((event) => event.runId === retrieve.runId || event.source === "mcp").slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-[1380px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full border px-3 py-1 font-mono text-[10px] ${ready ? "border-[#a9d6bc] bg-[#f1fbf5] text-[#287a52]" : "border-[#efc0a6] bg-[#fff8f3] text-accent"}`}>{ready ? "ready for agent" : "needs review"}</span>
          </div>
          <h1 className="mt-3 max-w-4xl text-3xl font-semibold tracking-[-0.035em]">{ready ? "Preflight ready" : "Request needs more detail"}</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">{request}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onProof} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Inspect proof</button>
          <button type="button" disabled={!ready} onClick={onGuard} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Verify the patch <span className="ml-2" aria-hidden="true">→</span></button>
        </div>
      </div>

      <dl className="mt-7 grid overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-4">
        <ProofMetric label="Repository searched" value={fmt(retrieve.quality.filesChecked)} detail="indexed files" />
        <ProofMetric label="Context selected" value={String(retrieve.quality.filesSelected)} detail="files for the agent" />
        <ProofMetric label="Graph paths" value={fmt(retrieve.traversal.pathCount)} detail={retrieve.traversal.engine} tone="accent" />
        <ProofMetric label="Tests found" value={String(retrieve.quality.testsFound)} detail="connected guards" />
      </dl>

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
              <ul className="mt-2 divide-y divide-[#c7deeb] border-y border-[#c7deeb]">
                {contract?.tests.slice(0, 4).map((test) => <li key={test.symbol} className="break-all py-2.5 font-mono text-[10px] leading-5">{test.symbol}</li>)}
              </ul>
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

function ConnectAgentView({ meta, events, copied, onCopy }: { meta: Meta | null; events: ActivityEvent[]; copied: CopyTarget; onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void> }) {
  const config = JSON.stringify({
    mcpServers: {
      lumos: {
        command: "pnpm",
        args: ["mcp"],
        cwd: meta?.workspace ?? "/absolute/path/to/lumos",
      },
    },
  }, null, 2);
  const mcpEvents = events.filter((event) => event.source === "mcp");
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="max-w-4xl">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">Connect your coding agent</h1>
        <p className="mt-2 text-sm leading-6 text-muted">Add the local MCP server once. Your agent can preflight a request, inspect proof, and verify its patch from the IDE.</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(30rem,1.1fr)_minmax(22rem,0.9fr)]">
        <section className="rounded-xl border border-line bg-panel p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">MCP configuration</p>
              <h2 className="mt-2 text-xl font-semibold">Cursor, Codex, or Claude Code</h2>
            </div>
            <StatusPill ready={meta?.ready === true}>{meta?.ready ? "server ready" : "server offline"}</StatusPill>
          </div>
          <ol className="mt-5 space-y-4 text-sm leading-6 text-muted">
            <li><strong className="text-foreground">1.</strong> Keep HydraDB and the Lumos repository available locally.</li>
            <li><strong className="text-foreground">2.</strong> Add this MCP server object to your agent&apos;s MCP configuration.</li>
            <li><strong className="text-foreground">3.</strong> Ask the agent to call <code className="font-mono text-xs text-foreground">lumos.preflight_change</code> before editing and <code className="font-mono text-xs text-foreground">lumos.verify_patch</code> after.</li>
          </ol>
          <div className="mt-6 overflow-hidden rounded-2xl border border-[#b8dbea] bg-[#eaf6fd]">
            <div className="flex items-center justify-between border-b border-[#b8dbea] px-4 py-3">
              <span className="font-mono text-[10px] text-[#315a75]">mcp.json</span>
              <button type="button" onClick={() => void onCopy(config, "config")} className={`min-h-9 rounded-lg border border-[#9ccbe5] bg-panel px-3 text-xs font-semibold text-foreground hover:border-lexical ${focusRing}`}>{copied === "config" ? "Configuration copied" : "Copy configuration"}</button>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6 text-[#173a55]"><code>{config}</code></pre>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted"><strong className="text-foreground">No OpenAI key is required.</strong> Lumos is the graph context layer used by the coding agent you already run.</p>
          <details className="mt-5 rounded-xl border border-line bg-inset p-4">
            <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Index your own Python repository</summary>
            <p className="mt-3 text-xs leading-5 text-muted">Index a local checkout, then set <code className="font-mono text-[10px]">LUMOS_REPO</code> and <code className="font-mono text-[10px]">LUMOS_ROOT</code> before starting the API and MCP server.</p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-panel p-3 font-mono text-[10px] leading-5"><code>{`pnpm lumos index /path/to/repo --slug owner/name
LUMOS_REPO=owner/name LUMOS_ROOT=/path/to/repo pnpm api`}</code></pre>
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
  connected,
  meta,
  graphReady,
  onDemo,
  copied,
  onCopy,
}: {
  connected: boolean;
  meta: Meta | null;
  graphReady: boolean;
  onDemo: () => void;
  copied: CopyTarget;
  onCopy: (value: string, target: Exclude<CopyTarget, null>) => Promise<void>;
}) {
  const setup = `pnpm lumos index /absolute/path/to/repo --slug owner/name
LUMOS_REPO=owner/name LUMOS_ROOT=/absolute/path/to/repo pnpm api`;

  return (
    <div className="onboarding-surface mx-auto min-h-full w-full max-w-[1040px] px-5 py-10 sm:px-10 lg:py-14">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">{connected ? "Repositories" : "Choose a repository"}</h1>
        <p className="mt-3 text-base leading-7 text-muted">{connected ? "Django is the active workspace. Index another local Python codebase when you are ready to switch." : "Start with the included Django snapshot or index a local Python codebase."}</p>
      </div>

      <section className="mt-9 overflow-hidden rounded-xl border border-[#bdd7e6] bg-panel shadow-[0_18px_48px_rgb(31_99_139_/_0.06)]">
        <div className="grid gap-5 border-b border-[#d2e3ec] p-5 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:items-center">
          <span className="grid h-11 w-11 place-items-center text-[#1f6e9b]"><Bug size={23} /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Django demo</h2>
              <span className="rounded-md bg-[#e6f4fb] px-2 py-1 text-[10px] font-medium text-[#24698f]">{connected ? "Active" : "Included"}</span>
            </div>
            <p className="mt-1 text-sm text-muted">{fmt(meta?.files ?? 0)} files indexed, {fmt(meta?.runs ?? 0)} saved runs, HydraDB {graphReady ? "ready" : "offline"}</p>
          </div>
          <button type="button" disabled={!graphReady} onClick={onDemo} className={`${buttonBase} gap-2 bg-[#123b55] text-white hover:bg-[#0d3047] ${focusRing}`}>{connected ? "Open workspace" : "Use demo"} <ArrowRight size={15} /></button>
        </div>

        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center text-[#1f6e9b]"><TerminalWindow size={23} /></span>
            <div>
              <h2 className="text-sm font-semibold">Index a local repository</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Run these commands from Lumos. The web workspace will use that repository when the API restarts.</p>
            </div>
          </div>
          <div className="mt-5 overflow-hidden rounded-lg border border-[#c8dce7] bg-[#eef6fb]">
            <div className="flex items-center justify-between border-b border-[#c8dce7] px-4 py-2.5">
              <span className="font-mono text-[10px] text-muted">Terminal</span>
              <button type="button" onClick={() => void onCopy(setup, "config")} className={`text-xs font-semibold text-muted hover:text-foreground ${focusRing}`}>{copied === "config" ? "Copied" : "Copy"}</button>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6 text-foreground"><code>{setup}</code></pre>
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted"><ShieldCheck size={15} className="mt-0.5 shrink-0" /> Local source only. Lumos does not upload repository contents or require an AI API key.</p>
        </div>
      </section>
    </div>
  );
}

function GraphExplorerView({
  impact,
  graphNodes,
  graphLinks,
  selectedNode,
  graphReady,
  busy,
  onWalk,
  onSelect,
}: {
  impact: ImpactResult | null;
  graphNodes: GraphNode[];
  graphLinks: GraphLink[];
  selectedNode: string | null;
  graphReady: boolean;
  busy: boolean;
  onWalk: (symbol: string) => void;
  onSelect: (node: string) => void;
}) {
  const [symbol, setSymbol] = useState("django.template.defaultfilters.join");
  const suggestions = [
    "django.template.defaultfilters.join",
    "django.urls.resolvers.URLResolver.resolve",
    "django.forms.fields.URLField.to_python",
  ];

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-line bg-panel px-5 py-5 sm:px-7">
        <div className="mx-auto w-full max-w-[1280px]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.025em]">Graph explorer</h1>
              <p className="mt-1 text-sm text-muted">Follow calls, coverage, and co-change paths from one Python symbol.</p>
            </div>
            <form className="flex w-full max-w-2xl gap-2" onSubmit={(event) => { event.preventDefault(); onWalk(symbol.trim()); }}>
              <label className="sr-only" htmlFor="graph-symbol">Python symbol</label>
              <div className="relative min-w-0 flex-1">
                <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input id="graph-symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="package.module.symbol" className={`h-10 w-full rounded-lg border border-line bg-background pl-9 pr-3 font-mono text-xs text-foreground placeholder:text-muted hover:border-[#aebfc9] ${focusRing}`} />
              </div>
              <button type="submit" disabled={!graphReady || busy || !symbol.trim()} className={`${buttonBase} bg-foreground text-panel hover:bg-[#2a3540] ${focusRing}`}>{busy ? "Walking" : "Trace"}</button>
            </form>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {suggestions.map((item) => <button key={item} type="button" onClick={() => { setSymbol(item); onWalk(item); }} className={`rounded-md border border-line bg-background px-2.5 py-1.5 font-mono text-[10px] text-muted hover:border-lexical hover:text-foreground ${focusRing}`}>{item.split(".").at(-1)}</button>)}
          </div>
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
  const examples = [
    { label: "Template bug", value: SAMPLE_ISSUE },
    { label: "Rate limiting", value: "Add rate limiting to the payment endpoint and update its tests." },
    { label: "Validation error", value: "A ValueError escapes from URL validation instead of returning ValidationError." },
  ];

  return (
    <div className="mx-auto min-h-full w-full max-w-[860px] px-5 py-10 sm:px-8 lg:py-14">
      <section>
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">What should the agent change?</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">Lumos checks all {fmt(meta?.files ?? 0)} indexed files and returns the smallest plan it can prove.</p>

        <div className="mt-6 flex flex-wrap gap-2" aria-label="Example requests">
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
        </div>

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
            placeholder="Example: The join template filter escapes its separator when autoescape is off."
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
          <span>HydraDB {graphReady ? "ready" : "offline"}</span>
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
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">{hasVerifiedPlan ? "Start with these files." : "No graph-backed edit plan yet."}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{hasVerifiedPlan ? `Lumos checked ${fmt(quality.filesChecked)} files and narrowed this change to ${quality.filesSelected}. Open any file to see why it belongs and which tests protect it.` : `Lumos checked ${fmt(quality.filesChecked)} files and found ${quality.filesSelected} text matches, but no repository path or connected test verified them. Refine the request before giving it to an agent.`}</p>
          </div>
          {hasVerifiedPlan ? <button type="button" onClick={onHandoff} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Create agent brief <span className="ml-2" aria-hidden="true">→</span></button> : <button type="button" onClick={onRequest} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Refine the request</button>}
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

// Kept as the full benchmark renderer; the control room currently uses its compact form.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function EvalView({ summary, demo, meta, onRefresh, onRunDemo, graphReady }: { summary: EvalSummary | null; demo: Demo | null; meta: Meta | null; onRefresh: () => void; onRunDemo: () => void; graphReady: boolean }) {
  if (!summary) return <EmptyView number="04" eyebrow="Why Lumos" title="Comparison data is unavailable." body="Start the local API to load the frozen research benchmark and the real graph disagreement case." action="Retry" onAction={onRefresh} />;
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-lexical">04 / Why Lumos</p>
          <h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.04em]">Search finds matching words. Lumos proves what is connected.</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">Lumos keeps text search for the initial shortlist, then uses HydraDB to explain the code relationships, find protecting tests, and create a brief your coding agent can act on.</p>
        </div>
      </div>

      <section className="mt-9 grid gap-4 md:grid-cols-2" aria-label="What Lumos adds to text search">
        <article className="rounded-[1.6rem] border border-line bg-panel p-6 sm:p-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Text search alone</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">A list of matching filenames.</h2>
          <ul className="mt-6 space-y-3 text-sm leading-6 text-muted">
            <li>• Good when the issue names the right symbol.</li>
            <li>• No explanation of how files are connected.</li>
            <li>• No connected test impact.</li>
            <li>• Leaves the agent to investigate the repository.</li>
          </ul>
        </article>
        <article className="rounded-[1.6rem] border border-[#efc0a6] bg-[#fff8f3] p-6 sm:p-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">Lumos</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">A shortlist with proof and tests.</h2>
          <ul className="mt-6 space-y-3 text-sm leading-6 text-muted">
            <li>• Keeps the lexical shortlist as the safe default.</li>
            <li>• Shows the call, coverage, and co-change paths.</li>
            <li>• Finds tests connected to the proposed edit.</li>
            <li>• Produces a compact, copyable agent brief.</li>
          </ul>
        </article>
      </section>

      <section className="mt-6 rounded-[1.6rem] border border-[#afd7e9] bg-[#eef9ff] p-6 sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)] lg:items-center">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">A real case where names mislead</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">The correct edit was hidden behind a relationship.</h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">In Django bug 16873, text similarity ranked the eventual patch file third. A covering-test path connected the request to that file, so Lumos could put it first and show the evidence.</p>
            <button type="button" disabled={!graphReady} onClick={onRunDemo} className={`${buttonBase} mt-6 bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>See this case in the workspace</button>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <span className="rounded-full border border-[#9bcde5] bg-panel px-3 py-1.5 font-mono text-[10px] text-lexical">{demo?.id ?? "django-16873"}</span>
            <dl className="grid w-full grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#b6d9ea] bg-[#b6d9ea] sm:grid-cols-4 lg:grid-cols-2">
              <CaseMetric label="Repository" value={`${fmt(meta?.files ?? 913)} files`} />
              <CaseMetric label="Text search" value="#3" />
              <CaseMetric label="Lumos" value="#1" accent />
              <CaseMetric label="Connected tests" value="20" />
            </dl>
          </div>
        </div>
      </section>

      <details className="mt-6 rounded-[1.4rem] border border-line bg-panel p-5">
        <summary className={`cursor-pointer text-sm font-semibold ${focusRing}`}>Open the full research benchmark</summary>
        <div className="mt-5 border-t border-line pt-5">
          <p className="max-w-4xl text-sm leading-6 text-muted">On {summary.n} frozen Django bugs, the previous experimental ranker tied BM25 at top-3 ({pct(summary.methods.hybrid.at3)}), while its top-1 result was {pct(summary.methods.hybrid.at1)} versus BM25 at {pct(summary.methods.bm25.at1)}. So Lumos does not claim to beat text search on every bug.</p>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-muted">The production rule is stricter: graph evidence is always attached, but it only reorders the shortlist when one candidate is corroborated by a connected covering test. The current value is inspectable proof, test impact, and a better agent handoff, not a blanket search-accuracy claim.</p>
          <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-line bg-inset p-4">
            <MetricBlock label="Graph helped" value={String(summary.hybridVsBm25.improved)} />
            <MetricBlock label="Graph hurt" value={String(summary.hybridVsBm25.hurt)} />
            <MetricBlock label="Unchanged" value={String(summary.hybridVsBm25.tie)} />
          </div>
          <p className="mt-4 font-mono text-[10px] leading-5 text-muted">These figures describe the frozen previous experiment; rerun the benchmark after the stricter promotion gate before publishing a new top-1 number.</p>
        </div>
      </details>
    </div>
  );
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
