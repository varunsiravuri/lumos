"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlastGraph, type GraphLink, type GraphNode } from "./blast-graph";
import { LumosLogo } from "./lumos-logo";

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

type WorkspaceView = "overview" | "request" | "live" | "proof" | "guard" | "runs" | "connect";
type CopyTarget = "path" | "markdown" | "json" | "config" | null;

const views: { id: WorkspaceView; label: string; eyebrow: string }[] = [
  { id: "overview", label: "Overview", eyebrow: "Repository health" },
  { id: "request", label: "New change", eyebrow: "Run a preflight" },
  { id: "live", label: "Live run", eyebrow: "Watch the trace" },
  { id: "proof", label: "Proof", eyebrow: "Inspect files and tests" },
  { id: "guard", label: "Patch Guard", eyebrow: "Verify the edit" },
  { id: "runs", label: "Runs", eyebrow: "Reopen prior work" },
  { id: "connect", label: "Connect agent", eyebrow: "Use MCP in your IDE" },
];

const SAMPLE_ISSUE =
  "Template filter `join` should not escape the joining string if `autoescape` is `off`";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

const buttonBase =
  "inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function repoLabel(repo?: string): string {
  if (!repo) return "No repo loaded";
  return repo.includes("/") ? repo.split("/").at(-1) ?? repo : repo;
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

function validView(value: string | null): value is WorkspaceView {
  return value === "overview" || value === "request" || value === "live" || value === "proof" || value === "guard" || value === "runs" || value === "connect";
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
    ? contract.tests.map((test) => `- \`${test.symbol}\` — ${test.via}`).join("\n")
    : "- No covering tests were found.";

  return `# Lumos context handoff\n\n## Request\n${contract.request}\n\n## Ranked targets\n${targets}\n\n## Tests\n${tests}\n\n## Graph traversal\n- Engine: ${contract.traversal.engine}\n- Direction: ${contract.traversal.direction}\n- Relationships: ${contract.traversal.relTypes.join(", ")}\n- Paths checked: ${contract.traversal.pathCount}\n- Walk time: ${contract.traversal.elapsedMs} ms`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function Workstation() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const view: WorkspaceView = validView(requestedView) ? requestedView : "overview";
  const [issue, setIssue] = useState("");
  const [activeRequest, setActiveRequest] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [gold, setGold] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
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

  const navigate = useCallback((nextView: WorkspaceView, replace = false) => {
    const href = `/app?view=${nextView}`;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [router]);

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
      navigate("live");
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
      navigate(destination);
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

  async function walkSymbol(symbol: string) {
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
      setMapOpen(true);
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

  return (
    <div className="workstation-sky min-h-dvh overflow-hidden text-foreground lg:p-3">
      <div className="workstation-shell flex h-dvh flex-col overflow-hidden border-sky-line bg-panel max-lg:border-t-4 max-lg:border-t-sky-bg lg:h-[calc(100dvh-1.5rem)] lg:rounded-2xl lg:border">
        <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-line bg-panel px-4 lg:px-5">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/" className={`shrink-0 rounded-sm ${focusRing}`} aria-label="Back to Lumos landing page">
              <LumosLogo size="sm" tone="app" />
            </Link>
            <div className="hidden min-w-0 border-l border-line pl-4 sm:block">
              <p className="truncate text-sm font-semibold">{repoLabel(meta?.repo)}</p>
              <p className="font-mono text-[11px] text-muted">{fmt(meta?.files ?? 0)} indexed files</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <StatusPill ready={graphReady}>{graphReady ? "graph live" : "graph offline"}</StatusPill>
            <Link href="/docs" className={`${buttonBase} hidden border border-line bg-panel px-4 text-foreground hover:border-lexical/60 sm:inline-flex ${focusRing}`}>
              Docs
            </Link>
            <Link href="/" className={`${buttonBase} border border-line bg-panel px-4 text-foreground hover:border-lexical/60 ${focusRing}`}>
              Site
            </Link>
          </div>
        </header>

        {!graphReady ? (
          <Notice tone="blue" message={<>The HydraDB graph is offline. Start it with <code className="font-mono font-semibold text-foreground">pnpm db:up</code>.</>}>
            <button type="button" onClick={() => void refreshMeta()} className={`${buttonBase} min-h-9 border border-line bg-panel px-3 text-foreground ${focusRing}`}>
              Retry
            </button>
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="orange" message={error}>
            <button type="button" onClick={() => setError(null)} className={`${buttonBase} min-h-9 border border-[#efc7b3] bg-panel px-3 text-foreground ${focusRing}`}>
              Dismiss
            </button>
          </Notice>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="hidden w-[17.5rem] shrink-0 flex-col border-r border-line bg-panel p-4 lg:flex">
            <div className="px-2 pb-4 pt-2">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">Lumos workspace</p>
              <p className="mt-2 text-sm leading-5 text-muted">Preflight the change. Give the agent proof. Verify what it changed.</p>
            </div>
            <WorkspaceNav view={view} retrieve={retrieve} runs={runs} events={events} onNavigate={navigate} />
            <div className="mt-auto rounded-2xl border border-line bg-inset p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] text-muted">Repository</span>
                <span className={`h-2 w-2 rounded-full ${graphReady ? "bg-[#2f9e68]" : "bg-accent"}`} />
              </div>
              <p className="mt-2 truncate text-sm font-semibold">{repoLabel(meta?.repo)}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
                <SmallStat label="Files" value={fmt(meta?.files ?? 0)} />
                <SmallStat label="Engine" value={meta?.engine ?? "offline"} />
              </dl>
            </div>
          </aside>

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <div className="border-b border-line bg-panel lg:hidden">
              <div className="px-4 py-2.5 sm:hidden">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{repoLabel(meta?.repo)}</p>
                  <p className="font-mono text-[10px] text-muted">{fmt(meta?.files ?? 0)} indexed files</p>
                </div>
              </div>
              <WorkspaceNav view={view} retrieve={retrieve} runs={runs} events={events} onNavigate={navigate} mobile />
            </div>

            {retrieve ? <RunContext request={activeRequest} retrieve={retrieve} onRequest={() => navigate("request")} /> : null}

            <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
              {view === "overview" ? (
                <OverviewView
                  meta={meta}
                  summary={evalSummary}
                  latestRun={runs[0] ?? null}
                  events={events}
                  graphReady={graphReady}
                  onNew={() => navigate("request")}
                  onDemo={() => void loadDemo()}
                  onOpenRun={(id) => void openRun(id)}
                  onConnect={() => navigate("connect")}
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
              {view === "live" ? (
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
              {view === "proof" ? (
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
              {view === "guard" ? (
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
                  onOpen={(id) => void openRun(id)}
                  onRefresh={() => void refreshRuns()}
                  onNew={() => navigate("request")}
                />
              ) : null}
              {view === "connect" ? (
                <ConnectAgentView meta={meta} events={events} copied={copied} onCopy={copyText} />
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
    </div>
  );
}

function WorkspaceNav({
  view,
  retrieve,
  runs,
  events,
  onNavigate,
  mobile = false,
}: {
  view: WorkspaceView;
  retrieve: RetrieveResult | null;
  runs: RunSummary[];
  events: ActivityEvent[];
  onNavigate: (view: WorkspaceView) => void;
  mobile?: boolean;
}) {
  if (mobile) {
    return (
      <nav className="flex overflow-x-auto px-2" aria-label="Workspace views">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
            className={`relative min-h-12 min-w-[7rem] px-3 text-xs font-semibold ${focusRing} ${view === item.id ? "text-lexical" : "text-muted"}`}
          >
            {item.label}
            {view === item.id ? <span className="absolute inset-x-3 bottom-0 h-0.5 bg-lexical" /> : null}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <nav className="space-y-1" aria-label="Workspace views">
      {views.map((item, index) => {
        const active = view === item.id;
        const status =
          item.id === "overview" ? "home" :
          item.id === "request" ? "new" :
          item.id === "live" ? (retrieve ? "active" : "waiting") :
          item.id === "proof" ? `${retrieve?.ranked.length ?? 0} files` :
          item.id === "guard" ? (retrieve?.quality.mode && retrieve.quality.mode !== "text-only" ? "ready" : retrieve ? "needs proof" : "waiting") :
          item.id === "runs" ? String(runs.length) :
          `${events.filter((event) => event.source === "mcp").length} calls`;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
            className={`group grid min-h-[4.6rem] w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 text-left transition-colors duration-150 ${focusRing} ${active ? "border-[#acd2e7] bg-[#eef8fe]" : "border-transparent hover:border-line hover:bg-inset"}`}
          >
            <ViewGlyph view={item.id} active={active} />
            <span className="min-w-0">
              <span className={`block text-sm font-semibold ${active ? "text-foreground" : "text-muted group-hover:text-foreground"}`}>{item.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">{item.eyebrow}</span>
            </span>
            <span className={`font-mono text-[9px] ${active ? "text-lexical" : "text-muted"}`}>{index === 0 ? status : status}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ViewGlyph({ view, active }: { view: WorkspaceView; active: boolean }) {
  const glyph: Record<WorkspaceView, string> = {
    overview: "⌂",
    request: "+",
    live: "↻",
    proof: "•••",
    guard: "✓",
    runs: "≡",
    connect: "↗",
  };
  return (
    <span aria-hidden="true" className={`grid h-8 w-8 place-items-center rounded-xl border font-mono text-xs ${active ? "border-[#9ccbe5] bg-panel text-lexical" : "border-line bg-panel text-muted"}`}>
      {glyph[view]}
    </span>
  );
}

function RunContext({ request, retrieve, onRequest }: { request: string; retrieve: RetrieveResult; onRequest: () => void }) {
  const quality = retrieve.quality ?? {
    filesChecked: 0,
    filesSelected: retrieve.ranked.length,
    graphEvidenceFiles: retrieve.ranked.filter((file) => file.evidence.length > 0).length,
    testsFound: retrieve.tests.length,
    mode: "text-only" as const,
  };
  return (
    <section className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5 lg:px-6" aria-label="Current run">
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_4px_rgb(198_95_44_/_0.1)]" />
      <button type="button" onClick={onRequest} className={`min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground hover:text-lexical ${focusRing}`} title={request}>
        {request}
      </button>
      <div className="hidden shrink-0 items-center gap-4 font-mono text-[10px] text-muted sm:flex">
        <span>{fmt(quality.filesChecked)} checked</span>
        <span>{quality.filesSelected} selected</span>
        <span>{quality.testsFound} tests</span>
      </div>
    </section>
  );
}

function OverviewView({
  meta,
  summary,
  latestRun,
  events,
  graphReady,
  onNew,
  onDemo,
  onOpenRun,
  onConnect,
}: {
  meta: Meta | null;
  summary: EvalSummary | null;
  latestRun: RunSummary | null;
  events: ActivityEvent[];
  graphReady: boolean;
  onNew: () => void;
  onDemo: () => void;
  onOpenRun: (id: string) => void;
  onConnect: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[1380px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <section className="grid gap-8 rounded-[1.8rem] border border-[#b8dceb] bg-panel p-6 shadow-[0_24px_70px_rgb(36_112_158_/_0.09)] lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)] lg:p-9">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">Repository control room</p>
            <StatusPill ready={graphReady}>{graphReady ? "ready for agent preflight" : "graph offline"}</StatusPill>
          </div>
          <h1 className="mt-5 max-w-4xl text-4xl font-semibold leading-[1.03] tracking-[-0.045em] sm:text-5xl">Know the change is safe before—and after—the agent edits.</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-muted">Lumos searches the full repository, proves the smallest relevant context through HydraDB, hands it to your coding agent, then checks whether the patch stayed inside that proof.</p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button type="button" disabled={!graphReady} onClick={onNew} className={`${buttonBase} bg-accent px-5 text-white hover:bg-[#a94d23] ${focusRing}`}>Preflight a change</button>
            <button type="button" disabled={!graphReady} onClick={onDemo} className={`${buttonBase} border border-line bg-panel px-5 text-foreground hover:border-lexical/60 ${focusRing}`}>Run the Django proof case</button>
          </div>
        </div>
        <div className="rounded-[1.4rem] border border-line bg-inset p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] text-muted">Indexed repository</p>
              <h2 className="mt-2 text-xl font-semibold">{meta?.repo ?? "Waiting for repository"}</h2>
            </div>
            <span className={`mt-1 h-3 w-3 rounded-full ${graphReady ? "bg-[#2f9e68] shadow-[0_0_0_5px_rgb(47_158_104_/_0.10)]" : "bg-accent"}`} />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line">
            <CaseMetric label="Files searchable" value={fmt(meta?.files ?? 0)} />
            <CaseMetric label="Saved runs" value={fmt(meta?.runs ?? 0)} />
            <CaseMetric label="Graph engine" value="HydraDB" accent />
            <CaseMetric label="Agent tools" value={String(meta?.mcpTools?.length ?? 0)} />
          </dl>
          <p className="mt-4 break-all font-mono text-[10px] leading-5 text-muted">{meta?.root ?? "Start the API to load repository metadata."}</p>
        </div>
      </section>

      <section className="mt-7" aria-labelledby="product-loop-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">The complete loop</p>
            <h2 id="product-loop-title" className="mt-2 text-3xl font-semibold tracking-[-0.035em]">From request to verified patch.</h2>
          </div>
          <button type="button" onClick={onConnect} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Connect your agent <span className="ml-2" aria-hidden="true">→</span></button>
        </div>
        <ol className="mt-5 grid overflow-hidden rounded-[1.6rem] border border-line bg-panel md:grid-cols-4">
          <LoopStep number="01" title="Preflight" detail={`Search all ${fmt(meta?.files ?? 0)} files before editing.`} />
          <LoopStep number="02" title="Prove" detail="Walk calls, coverage, and co-change relationships." />
          <LoopStep number="03" title="Handoff" detail="Send a compact context contract through MCP." />
          <LoopStep number="04" title="Patch Guard" detail="Check the files and tests the agent actually touched." last />
        </ol>
      </section>

      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <section className="rounded-[1.6rem] border border-[#b4d8ea] bg-[#eef9ff] p-6 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Why the graph matters</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">When matching names point at the wrong file.</h2>
            </div>
            <span className="rounded-full border border-[#9bcde5] bg-panel px-3 py-1.5 font-mono text-[10px] text-lexical">django-16873</span>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-muted">Word search ranked the actual patch file third. A HydraDB coverage path connected the named filter to its protecting test, so Lumos promoted the file to first and exposed the reason.</p>
          <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-[#b6d9ea] bg-[#b6d9ea]">
            <CaseMetric label="Word search" value="#3" />
            <CaseMetric label="Lumos" value="#1" accent />
            <CaseMetric label="Connected tests" value="20" />
          </div>
          {summary ? <p className="mt-4 text-xs leading-5 text-muted">Across the frozen {summary.n}-case evaluation, Lumos does not claim a blanket ranking win. It keeps word search as the safe default and reorders only when graph evidence is corroborated.</p> : null}
        </section>

        <section className="rounded-[1.6rem] border border-line bg-panel p-6 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lexical">Recent activity</p>
              <h2 className="mt-2 text-xl font-semibold">Agent and workspace calls</h2>
            </div>
            <span className="font-mono text-[10px] text-muted">live</span>
          </div>
          {events.length ? (
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {events.slice(0, 4).map((event) => (
                <li key={event.id} className="grid grid-cols-[0.65rem_minmax(0,1fr)_auto] gap-3 py-3.5">
                  <span className={`mt-1.5 h-2 w-2 rounded-full ${event.state === "complete" ? "bg-[#2f9e68]" : "bg-accent"}`} />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px] font-semibold">{event.tool}</span>
                    <span className="mt-1 block truncate text-xs text-muted">{event.summary}</span>
                  </span>
                  <time className="font-mono text-[9px] text-muted" dateTime={event.at}>{timeAgo(event.at)}</time>
                </li>
              ))}
            </ul>
          ) : <p className="mt-5 rounded-2xl border border-dashed border-line p-5 text-sm leading-6 text-muted">No calls yet. Run a preflight here or connect an IDE agent; activity will appear in this ledger.</p>}
          {latestRun ? <button type="button" onClick={() => onOpenRun(latestRun.id)} className={`${buttonBase} mt-5 w-full border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Open latest run · {timeAgo(latestRun.completedAt)}</button> : null}
        </section>
      </div>
    </div>
  );
}

function LoopStep({ number, title, detail, last = false }: { number: string; title: string; detail: string; last?: boolean }) {
  return (
    <li className={`relative min-h-48 p-6 ${last ? "" : "border-b border-line md:border-b-0 md:border-r"}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-semibold text-lexical">{number}</span>
        {!last ? <span className="hidden font-mono text-xs text-[#8dbbd4] md:inline" aria-hidden="true">····→</span> : null}
      </div>
      <h3 className="mt-9 text-xl font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{detail}</p>
    </li>
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
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">Live preflight</p>
            <span className={`rounded-full border px-3 py-1 font-mono text-[10px] ${ready ? "border-[#a9d6bc] bg-[#f1fbf5] text-[#287a52]" : "border-[#efc0a6] bg-[#fff8f3] text-accent"}`}>{ready ? "ready for agent" : "needs review"}</span>
          </div>
          <h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.04em]">{ready ? "The repository has answered." : "The graph needs a clearer request."}</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">{request}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onProof} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Inspect proof</button>
          <button type="button" disabled={!ready} onClick={onGuard} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>Verify the patch <span className="ml-2" aria-hidden="true">→</span></button>
        </div>
      </div>

      <dl className="mt-7 grid overflow-hidden rounded-[1.5rem] border border-line bg-panel sm:grid-cols-4">
        <ProofMetric label="Repository searched" value={fmt(retrieve.quality.filesChecked)} detail="indexed files" />
        <ProofMetric label="Context selected" value={String(retrieve.quality.filesSelected)} detail="files for the agent" />
        <ProofMetric label="Graph paths" value={fmt(retrieve.traversal.pathCount)} detail={retrieve.traversal.engine} tone="accent" />
        <ProofMetric label="Tests found" value={String(retrieve.quality.testsFound)} detail="connected guards" />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(25rem,0.9fr)_minmax(30rem,1.1fr)]">
        <section className="rounded-[1.6rem] border border-line bg-panel p-5 sm:p-6">
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

        <section className="rounded-[1.6rem] border border-[#abd4e8] bg-[#eef9ff] p-5 shadow-[0_22px_60px_rgb(24_84_120_/_0.08)] sm:p-7">
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

      <section className="mt-6 rounded-[1.4rem] border border-line bg-panel p-5">
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
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">Post-edit verification</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">Did the agent change what the graph proved?</h1>
        <p className="mt-3 text-base leading-7 text-muted">Paste repository-relative paths from the patch and the tests the agent ran. Lumos compares them with preflight <code className="font-mono text-xs text-foreground">{retrieve.runId}</code>.</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(24rem,0.85fr)_minmax(30rem,1.15fr)]">
        <form onSubmit={(event) => void verify(event)} className="rounded-[1.6rem] border border-line bg-panel p-5 sm:p-6">
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

        <section className="rounded-[1.6rem] border border-[#b4d8ea] bg-[#eef9ff] p-5 sm:p-7" aria-live="polite">
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
                <CaseMetric label="Expected target" value={shortPath(retrieve.ranked[0]?.path ?? "—")} />
                <CaseMetric label="Connected tests" value={String(retrieve.tests.length)} />
              </dl>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RunsView({ runs, loading, currentRunId, onOpen, onRefresh, onNew }: { runs: RunSummary[]; loading: boolean; currentRunId: string | null; onOpen: (id: string) => void; onRefresh: () => void; onNew: () => void }) {
  if (loading) return <ResultSkeleton />;
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">Run history</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">Every preflight is reusable evidence.</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted">Reopen a previous request with its exact ranking, graph traversal, tests, and context contract.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onRefresh} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>Refresh</button>
          <button type="button" onClick={onNew} className={`${buttonBase} bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>New preflight</button>
        </div>
      </div>
      {runs.length ? (
        <ol className="mt-8 overflow-hidden rounded-[1.6rem] border border-line bg-panel">
          {runs.map((run, index) => (
            <li key={run.id} className={index === runs.length - 1 ? "" : "border-b border-line"}>
              <button type="button" onClick={() => onOpen(run.id)} className={`grid min-h-[7.5rem] w-full gap-4 px-5 py-4 text-left transition-colors duration-100 hover:bg-inset sm:grid-cols-[8rem_minmax(0,1fr)_minmax(14rem,0.55fr)_auto] sm:items-center ${focusRing}`}>
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
                <span className="font-mono text-xs text-lexical" aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ol>
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
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">IDE connection</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">Put Lumos before and after every agent edit.</h1>
        <p className="mt-3 text-base leading-7 text-muted">Connect the local MCP server once. Your coding agent can preflight a request, inspect graph proof, and verify its patch without leaving the IDE.</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(30rem,1.1fr)_minmax(22rem,0.9fr)]">
        <section className="rounded-[1.6rem] border border-line bg-panel p-5 sm:p-7">
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
              <button type="button" onClick={() => void onCopy(config, "config")} className={`min-h-10 rounded-full border border-[#9ccbe5] bg-panel px-3 text-xs font-semibold text-foreground hover:border-lexical ${focusRing}`}>{copied === "config" ? "Configuration copied" : "Copy configuration"}</button>
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
          <section className="rounded-[1.6rem] border border-[#b4d8ea] bg-[#eef9ff] p-5 sm:p-6">
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
          <section className="rounded-[1.6rem] border border-line bg-panel p-5 sm:p-6">
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
    { label: "Fix a bug", value: SAMPLE_ISSUE },
    { label: "Add a feature", value: "Add rate limiting to the payment endpoint and update its tests." },
    { label: "Follow an error", value: "A ValueError escapes from URL validation instead of returning ValidationError." },
  ];

  return (
    <div className="mx-auto grid min-h-full w-full max-w-[1280px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(19rem,0.6fr)] lg:px-10 lg:py-12 xl:gap-14">
      <section>
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-lexical">01 / Ask Lumos</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.04] tracking-[-0.04em] sm:text-5xl">Know where to edit before AI starts coding.</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted">Describe one code change. Lumos checks all {fmt(meta?.files ?? 0)} indexed files, follows the repository graph, and returns only the files and tests that matter.</p>

        <div className="mt-7 flex flex-wrap gap-2" aria-label="Example requests">
          {examples.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => {
                setIssue(example.value);
                window.setTimeout(() => issueRef.current?.focus(), 0);
              }}
              className={`min-h-10 rounded-full border border-line bg-panel px-3.5 text-xs font-semibold text-muted hover:border-lexical/60 hover:text-foreground ${focusRing}`}
            >
              {example.label}
            </button>
          ))}
        </div>

        <form
          className="mt-5 rounded-[1.6rem] border border-[#badbeb] bg-panel p-3 shadow-[0_22px_65px_rgb(36_112_158_/_0.10)] sm:p-4"
          onSubmit={(event) => {
            event.preventDefault();
            onRun(issue);
          }}
        >
          <label htmlFor="agent-request" className="mb-2 block px-1 text-sm font-semibold">What should change?</label>
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
            rows={5}
            aria-invalid={requestError ? true : undefined}
            aria-describedby={requestError ? "request-error" : "request-help"}
            placeholder="Example: The join template filter escapes its separator when autoescape is off."
            className={`min-h-44 w-full resize-y rounded-[1.15rem] border bg-inset px-4 py-4 text-sm leading-7 text-foreground placeholder:text-muted/70 hover:border-[#9cc5dc] ${requestError ? "border-accent" : "border-line"} ${focusRing}`}
          />
          {requestError ? <p id="request-error" role="alert" className="px-1 pt-2 text-sm leading-6 text-accent">{requestError}</p> : <p id="request-help" className="px-1 pt-2 text-xs leading-5 text-muted">A useful request names the behavior, error, feature, function, or stack trace involved.</p>}
          <div className="flex flex-col gap-3 px-1 pb-1 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted"><kbd className="rounded border border-line bg-inset px-1.5 py-1 font-mono text-[10px]">⌘ Enter</kbd> to run</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" disabled={busy || !graphReady} onClick={onDemo} className={`${buttonBase} border border-line bg-panel text-foreground hover:border-lexical/60 ${focusRing}`}>
                Show me with a real bug
              </button>
              <button type="submit" disabled={busy || !issue.trim() || !graphReady} className={`${buttonBase} min-w-40 bg-accent text-white hover:bg-[#a94d23] ${focusRing}`}>
                {busy ? "Checking repository…" : "Find the right files"}
              </button>
            </div>
          </div>
        </form>

        {retrieve ? (
          <button type="button" onClick={onProof} className={`mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-lexical hover:text-foreground ${focusRing}`}>
            Return to the latest edit plan <span aria-hidden="true">→</span>
          </button>
        ) : null}
      </section>

      <aside className="lg:pt-16">
        <div className="relative overflow-hidden rounded-[1.6rem] border border-line bg-panel p-6">
          <div className="absolute -right-14 -top-14 h-40 w-40 rounded-full bg-[#d7f0fc] blur-2xl" aria-hidden="true" />
          <p className="relative font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lexical">What you get</p>
          <ol className="relative mt-6 space-y-0">
            <RequestStep number="01" title="Where to edit" detail="A short list ordered for this exact change." active />
            <RequestStep number="02" title="Why each file belongs" detail="The repository relationships behind every recommendation." />
            <RequestStep number="03" title="Which tests protect it" detail="Tests connected to the code the agent may touch." />
            <RequestStep number="04" title="A ready agent brief" detail="A focused plan you can copy into Cursor, Codex, or Claude Code." last />
          </ol>
          <div className="relative mt-1 rounded-2xl border border-[#b6d9ea] bg-[#f2faff] p-4">
            <p className="text-sm font-semibold">{fmt(meta?.files ?? 0)} files checked → up to 12 strongest candidates</p>
            <p className="mt-1 text-xs leading-5 text-muted">The number returned is the shortlist, not the number searched.</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <InfoTile label="Repository" value={repoLabel(meta?.repo)} />
          <InfoTile label="HydraDB" value={graphReady ? "Connected" : "Offline"} accent={graphReady} />
        </div>
        <p className="mt-5 border-l-2 border-lexical pl-4 text-sm leading-6 text-muted"><strong className="text-foreground">No AI API key required.</strong> Lumos builds context for the coding agent you already use; it does not call a language model here.</p>
      </aside>
    </div>
  );
}

function RequestStep({ number, title, detail, active = false, last = false }: { number: string; title: string; detail: string; active?: boolean; last?: boolean }) {
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
      <div className="flex flex-col items-center">
        <span className={`grid h-8 w-8 place-items-center rounded-full border font-mono text-[10px] ${active ? "border-accent bg-[#fff4ec] text-accent" : "border-[#a9d2e8] bg-[#f4fbff] text-lexical"}`}>{number}</span>
        {!last ? <span className="min-h-12 w-px flex-1 bg-line" /> : null}
      </div>
      <div className="pb-6">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{detail}</p>
      </div>
    </li>
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
            <ProofMetric label={hasVerifiedPlan ? "Start here" : "Verified start"} value={hasVerifiedPlan ? "#1" : "—"} detail={hasVerifiedPlan ? shortPath(topFile?.path ?? "—") : "refine request"} tone="accent" />
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
        {withoutGraph.length ? <ul className="mt-4 border-t border-line pt-4 text-sm text-muted">{withoutGraph.map((line) => <li key={line} className="mt-1">— {line}</li>)}</ul> : null}
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
            <li>— Good when the issue names the right symbol.</li>
            <li>— No explanation of how files are connected.</li>
            <li>— No connected test impact.</li>
            <li>— Leaves the agent to investigate the repository.</li>
          </ul>
        </article>
        <article className="rounded-[1.6rem] border border-[#efc0a6] bg-[#fff8f3] p-6 sm:p-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">Lumos</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">A shortlist with proof and tests.</h2>
          <ul className="mt-6 space-y-3 text-sm leading-6 text-muted">
            <li>— Keeps the lexical shortlist as the safe default.</li>
            <li>— Shows the call, coverage, and co-change paths.</li>
            <li>— Finds tests connected to the proposed edit.</li>
            <li>— Produces a compact, copyable agent brief.</li>
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
          <p className="mt-3 max-w-4xl text-sm leading-6 text-muted">The production rule is stricter: graph evidence is always attached, but it only reorders the shortlist when one candidate is corroborated by a connected covering test. The current value is inspectable proof, test impact, and a better agent handoff—not a blanket search-accuracy claim.</p>
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

function InfoTile({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="rounded-2xl border border-line bg-panel p-4"><p className="font-mono text-[9px] text-muted">{label}</p><p className={`mt-2 truncate text-sm font-semibold ${accent ? "text-[#287a52]" : "text-foreground"}`}>{value}</p></div>;
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
