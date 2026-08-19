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
}

interface Meta {
  ready: boolean;
  repo: string;
  files: number;
  engine: string;
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

type WorkspaceView = "request" | "proof" | "handoff" | "eval";
type CopyTarget = "path" | "markdown" | "json" | null;

const views: { id: WorkspaceView; label: string; eyebrow: string }[] = [
  { id: "request", label: "Ask Lumos", eyebrow: "Describe one change" },
  { id: "proof", label: "Edit plan", eyebrow: "See files and tests" },
  { id: "handoff", label: "Send to agent", eyebrow: "Copy a ready brief" },
  { id: "eval", label: "Why Lumos", eyebrow: "What the graph adds" },
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
  return value === "request" || value === "proof" || value === "handoff" || value === "eval";
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

export function Workstation() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const view: WorkspaceView = validView(requestedView) ? requestedView : "request";
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

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshMeta(), refreshEval()]);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshEval, refreshMeta]);

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
      request: activeRequest,
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
  const markdown = useMemo(() => (contract ? contractMarkdown(contract) : ""), [contract]);

  useEffect(() => {
    let cancelled = false;
    if (!contractJson) return;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(contractJson)).then((buffer) => {
      if (cancelled) return;
      setDigest(Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    });
    return () => {
      cancelled = true;
    };
  }, [contractJson]);

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
      navigate("proof");
    } catch (err) {
      setError(err instanceof Error ? err.message : "retrieve failed");
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
              <p className="mt-2 text-sm leading-5 text-muted">Check the whole repository before your coding agent edits a file.</p>
            </div>
            <WorkspaceNav view={view} retrieve={retrieve} evalSummary={evalSummary} onNavigate={navigate} />
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
              <WorkspaceNav view={view} retrieve={retrieve} evalSummary={evalSummary} onNavigate={navigate} mobile />
            </div>

            {retrieve ? <RunContext request={activeRequest} retrieve={retrieve} onRequest={() => navigate("request")} /> : null}

            <main className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
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
                  onProof={() => navigate("proof")}
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
                  onHandoff={() => navigate("handoff")}
                />
              ) : null}
              {view === "handoff" ? (
                <HandoffView
                  contract={contract}
                  contractJson={contractJson}
                  markdown={markdown}
                  digest={digest}
                  copied={copied}
                  onCopy={copyText}
                  onDownload={downloadContract}
                  onRequest={() => navigate("request")}
                />
              ) : null}
              {view === "eval" ? (
                <EvalView summary={evalSummary} demo={demo} meta={meta} onRefresh={() => void refreshEval()} onRunDemo={() => void loadDemo()} graphReady={graphReady} />
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
  evalSummary,
  onNavigate,
  mobile = false,
}: {
  view: WorkspaceView;
  retrieve: RetrieveResult | null;
  evalSummary: EvalSummary | null;
  onNavigate: (view: WorkspaceView) => void;
  mobile?: boolean;
}) {
  if (mobile) {
    return (
      <nav className="grid grid-cols-4" aria-label="Workspace views">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
            className={`relative min-h-12 px-1 text-xs font-semibold ${focusRing} ${view === item.id ? "text-lexical" : "text-muted"}`}
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
          item.id === "proof" ? `${retrieve?.ranked.length ?? 0} files` :
          item.id === "handoff" ? (retrieve?.quality?.mode && retrieve.quality.mode !== "text-only" ? "ready" : "waiting") :
          item.id === "eval" ? `${evalSummary?.n ?? 0} cases` : "new run";
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
  const glyph = view === "request" ? "+" : view === "proof" ? "•••" : view === "handoff" ? "→" : "▥";
  return (
    <span aria-hidden="true" className={`grid h-8 w-8 place-items-center rounded-xl border font-mono text-xs ${active ? "border-[#9ccbe5] bg-panel text-lexical" : "border-line bg-panel text-muted"}`}>
      {glyph}
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
