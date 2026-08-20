/**
 * Rank the files a change will have to touch, given only the text of an issue.
 *
 * The shape of the argument:
 *
 *   1. Lexical search finds files that *talk like* the issue. It is very good
 *      at this and it is the baseline.
 *   2. The names in the issue are resolved to real definitions in the graph.
 *   3. Those definitions are walked outward — callers, callees, tests that
 *      exercise them, files that history says always change alongside — and the
 *      files reached are scored by how close they are to a named starting point.
 *
 * Step 3 is the part a text index structurally cannot do. A file that never
 * mentions the failing function, and shares no vocabulary with the report, can
 * still be two call hops away and be the file the fix belongs in. Lexical
 * search ranks it nowhere because there is nothing to match; the graph ranks it
 * highly because there is a path.
 *
 * Every score carries the evidence that produced it, so a result is never
 * "this looked similar" — it is "this calls the function you named, twice removed".
 */

import type { HydraClient } from "@lumos/graph";
import { closure, Edge, Label, UKEY_PROPERTY } from "@lumos/graph";
import type { GraphPath } from "@lumos/graph";

import { Bm25Index } from "./bm25.ts";
import { extractMentions, isSeedableMention, type Mention } from "./mentions.ts";
import { resolveSeeds, type Seed } from "./seeds.ts";

/** Relationship groups walked from each kind of seed, with how much each is trusted. */
const SYMBOL_EDGES = [Edge.CALLS, Edge.COVERS];
const FILE_EDGES = [Edge.CO_CHANGES];

const EDGE_WEIGHT: Record<string, number> = {
  // A call is a hard fact about the code as it is.
  [Edge.CALLS]: 1.0,
  // A test covering a symbol is where a fix gets proven, so it is worth
  // surfacing, but it is rarely the file being changed.
  [Edge.COVERS]: 0.5,
  // History, not structure: weaker per hop but it reaches places nothing else does.
  [Edge.CO_CHANGES]: 0.7,
  [Edge.IMPORTS]: 0.35,
};

/** How much of a seed's weight survives each hop away from it. */
const DECAY = 0.45;

export interface Evidence {
  /** Mention text that started the walk. */
  via: string;
  /** Hops from the seed. Zero means the issue named this file's contents directly. */
  depth: number;
  relTypes: string[];
  /** Symbol or file reached, for display. */
  reached: string;
}

export interface RankedFile {
  path: string;
  score: number;
  lexicalScore: number;
  graphScore: number;
  /** 1-based BM25 rank, or null if word search never returned this file. */
  bm25Rank: number | null;
  /** Strongest justification first. Empty when only lexical search found the file. */
  evidence: Evidence[];
  /** One line a judge can read without knowing the scorer. */
  why: string[];
}

export interface TestHit {
  path: string;
  qualname: string;
  depth: number;
  via: string;
}

export interface TraversalReport {
  engine: "HydraDB algo.MSpaths";
  direction: "both";
  relTypes: string[];
  seedCount: number;
  pathCount: number;
  elapsedMs: number;
}

export interface RetrieveOptions {
  repo: string;
  /** Files eligible to be returned, which is also the BM25 corpus. */
  files: readonly string[];
  /**
   * Files seeded from the lexical ranking, in addition to files named outright.
   * Daily preflight uses the top BM25 hits so short prompts still walk HydraDB.
   * Eval keeps this at 0 so hub files cannot overtake the frozen ranking experiment.
   */
  lexicalSeedCount?: number;
  /** Hops walked from symbol seeds. One hop is a direct caller or callee. */
  maxSymbolHops?: number;
  maxFileHops?: number;
  /**
   * Scales graph bonuses against the lexical score. 1 keeps the evidence
   * bonuses as written; 0 is BM25 only.
   */
  graphWeight?: number;
  limit?: number;
}

/** Top BM25 files that become HydraDB seeds when the issue names no symbols. */
export const LEXICAL_SEED_COUNT = 8;

/**
 * Credit given to the second, third and later seeds that reach the same file.
 *
 * Corroboration is real evidence — two independent names in the issue both
 * leading to one file says more than either alone — but it cannot be additive.
 * A hub like `django/db/models/fields/__init__.py` is reachable from nearly
 * every seed, and under a plain sum the most connected file in the repository
 * wins every query regardless of the question.
 */
const CORROBORATION = 0.6;

interface FileScore {
  lexical: number;
  /** Best contribution from each distinct seed, keyed by the seed's ukey. */
  bySeed: Map<string, number>;
  evidence: Evidence[];
}

function scoreOf(entry: FileScore): number {
  const contributions = [...entry.bySeed.values()].sort((a, b) => b - a);
  return contributions.reduce((total, value, rank) => total + value * CORROBORATION ** rank, 0);
}

function ensure(scores: Map<string, FileScore>, path: string): FileScore {
  let entry = scores.get(path);
  if (!entry) scores.set(path, (entry = { lexical: 0, bySeed: new Map(), evidence: [] }));
  return entry;
}

/** Record a piece of graph evidence, keeping only the strongest per seed. */
function credit(
  entry: FileScore,
  seed: Seed,
  contribution: number,
  evidence: Evidence,
): void {
  const previous = entry.bySeed.get(seed.ukey);
  if (previous !== undefined && previous >= contribution) return;
  entry.bySeed.set(seed.ukey, contribution);
  entry.evidence.push(evidence);
}

/**
 * Fold the paths returned by one traversal into per-file scores.
 *
 * Node zero of every path is the seed it started from, which is what makes
 * attribution possible: the walk is scored against the specific name in the
 * issue that reached it, not against the seed set as a whole.
 *
 * Attribution is also what keeps the arithmetic honest. A single seed can
 * produce hundreds of paths, and every one of them passes through that seed's
 * own file at depth zero. Scoring per path would count that file hundreds of
 * times and hand first place to whichever seed happened to be best connected.
 */
function accumulate(
  paths: GraphPath[],
  seeds: Map<string, Seed>,
  scores: Map<string, FileScore>,
  eligible: Set<string>,
): void {
  for (const path of paths) {
    const origin = path.nodes[0];
    if (!origin) continue;

    const seed = seeds.get(String(origin.properties[UKEY_PROPERTY] ?? ""));
    if (!seed) continue;

    for (let depth = 0; depth < path.nodes.length; depth += 1) {
      const node = path.nodes[depth]!;
      const filePath = String(node.properties.path ?? "");
      if (!eligible.has(filePath)) continue;

      const relTypes = path.relationships.slice(0, depth).map((rel) => rel.type);
      // The weakest link governs: a chain through an import and then a
      // co-change is only as trustworthy as the import made it.
      const edgeWeight = relTypes.reduce((total, type) => total * (EDGE_WEIGHT[type] ?? 0.5), 1);

      credit(ensure(scores, filePath), seed, seed.weight * edgeWeight * DECAY ** depth, {
        via: seed.via,
        depth,
        relTypes,
        reached: String(node.properties.qualname ?? node.properties.path ?? ""),
      });
    }
  }
}

function normalize(values: number[]): number {
  const max = Math.max(...values, 0);
  return max > 0 ? max : 1;
}

export interface RetrieveResult {
  ranked: RankedFile[];
  /** BM25 only. Same files, no graph term. */
  lexical: RankedFile[];
  /** Graph evidence only. Files with no walk fall off the list. */
  structural: RankedFile[];
  mentions: Mention[];
  seeds: Seed[];
  unresolved: string[];
  tests: TestHit[];
  traversal: TraversalReport;
  /** Files the graph surfaced that the lexical ranking placed nowhere useful. */
  graphOnly: string[];
}

function whyFrom(evidence: Evidence[], lexicalScore: number, bm25Rank: number | null): string[] {
  const lines: string[] = [];
  for (const item of evidence.slice(0, 3)) {
    if (item.depth === 0 && item.relTypes.length === 0) {
      lines.push(`contains seeded name “${item.via}” (${item.reached})`);
    } else if (item.relTypes.includes(Edge.COVERS)) {
      lines.push(`test coverage from “${item.via}” at hop ${item.depth}`);
    } else if (item.relTypes.includes(Edge.CO_CHANGES)) {
      lines.push(`co-changed with “${item.via}” in recent history`);
    } else if (item.relTypes.includes(Edge.CALLS)) {
      lines.push(`${item.relTypes.join(" → ")} from “${item.via}” · ${item.reached}`);
    } else {
      lines.push(`${item.relTypes.join(" → ") || "named"} · ${item.reached}`);
    }
  }
  if (lexicalScore === 0) lines.push("word search missed this file");
  else if (bm25Rank !== null && bm25Rank > 3) lines.push(`word search ranked this #${bm25Rank}`);
  return lines.slice(0, 4);
}

export async function retrieve(
  client: HydraClient,
  index: Bm25Index,
  issue: string,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const {
    repo,
    files,
    lexicalSeedCount = LEXICAL_SEED_COUNT,
    maxSymbolHops = 1,
    maxFileHops = 1,
    graphWeight = 1,
    limit = 20,
  } = options;

  const eligible = new Set(files);
  const scores = new Map<string, FileScore>();

  const lexical = index.search(issue, 200);
  const lexicalMax = normalize(lexical.map((hit) => hit.score));
  for (const hit of lexical) {
    ensure(scores, hit.path).lexical = hit.score / lexicalMax;
  }

  const mentions = extractMentions(issue);
  const seedable = mentions.filter(isSeedableMention);
  const { seeds, unresolved } = await resolveSeeds(client, seedable, {
    repo,
    files,
    lexicalPrior: lexical.map((hit) => hit.path).slice(0, 40),
  });

  // Lexical hits become seeds too, so the graph can expand outward from what
  // text search got right. Their weight is deliberately below a named mention:
  // this is a guess being followed, not a fact being followed.
  const seeded = [...seeds];
  for (const hit of lexical.slice(0, lexicalSeedCount)) {
    if (seeded.some((seed) => seed.path === hit.path && seed.label === Label.File)) continue;
    seeded.push({
      ukey: `${repo}#${hit.path}`,
      label: Label.File,
      path: hit.path,
      weight: 0.3 * (hit.score / lexicalMax),
      via: `lexical:${hit.path}`,
    });
  }

  const byUkey = new Map(seeded.map((seed) => [seed.ukey, seed]));
  const symbolSeeds = seeded.filter((seed) => seed.label === Label.Symbol);
  const fileSeeds = seeded.filter((seed) => seed.label === Label.File);

  const walkStarted = Date.now();
  const [symbolPaths, filePaths] = await Promise.all([
    symbolSeeds.length
      ? closure(client, {
          label: Label.Symbol,
          property: UKEY_PROPERTY,
          values: symbolSeeds.map((seed) => seed.ukey),
          relTypes: SYMBOL_EDGES,
          direction: "both",
          maxLen: maxSymbolHops,
          pathCount: 4000,
          resultLimit: 40_000,
        })
      : Promise.resolve([]),
    fileSeeds.length
      ? closure(client, {
          label: Label.File,
          property: UKEY_PROPERTY,
          values: fileSeeds.map((seed) => seed.ukey),
          relTypes: FILE_EDGES,
          direction: "both",
          maxLen: maxFileHops,
          pathCount: 2000,
          resultLimit: 20_000,
        })
      : Promise.resolve([]),
  ]);
  const elapsedMs = Date.now() - walkStarted;

  accumulate(symbolPaths, byUkey, scores, eligible);
  accumulate(filePaths, byUkey, scores, eligible);

  // A symbol seed vouches for the file that defines it even when the traversal
  // returned nothing, which happens for a leaf function nobody calls.
  for (const seed of symbolSeeds) {
    if (!eligible.has(seed.path)) continue;
    credit(ensure(scores, seed.path), seed, seed.weight, {
      via: seed.via,
      depth: 0,
      relTypes: [],
      reached: seed.ukey.split("#")[1] ?? "",
    });
  }

  const tests: TestHit[] = [];
  const seenTests = new Set<string>();
  for (const path of symbolPaths) {
    const origin = path.nodes[0];
    const seed = origin ? byUkey.get(String(origin.properties[UKEY_PROPERTY] ?? "")) : undefined;
    for (let depth = 0; depth < path.nodes.length; depth += 1) {
      const node = path.nodes[depth]!;
      const isTest = node.properties.is_test === true || node.properties.is_test === "true";
      const qualname = String(node.properties.qualname ?? "");
      const filePath = String(node.properties.path ?? "");
      if (!isTest || !qualname || seenTests.has(qualname)) continue;
      seenTests.add(qualname);
      tests.push({ path: filePath, qualname, depth, via: seed?.via ?? "" });
    }
  }
  tests.sort((a, b) => a.depth - b.depth);

  const combined = [...scores.entries()].map(([path, entry]) => ({ path, entry, graph: scoreOf(entry) }));

  const lexicalOrder = combined
    .filter(({ entry }) => entry.lexical > 0)
    .sort((a, b) => b.entry.lexical - a.entry.lexical || a.path.localeCompare(b.path));
  const bm25RankOf = new Map(lexicalOrder.map((file, index) => [file.path, index + 1]));

  const toRanked = (
    path: string,
    lexicalScore: number,
    graphScore: number,
    score: number,
    evidence: Evidence[],
  ): RankedFile => {
    const bm25Rank = bm25RankOf.get(path) ?? null;
    const cleaned = evidence
      .sort((a, b) => a.depth - b.depth)
      .filter((item, position, all) => all.findIndex((other) => other.reached === item.reached) === position)
      .slice(0, 3);
    return {
      path,
      lexicalScore,
      graphScore,
      score,
      bm25Rank,
      evidence: cleaned,
      why: whyFrom(cleaned, lexicalScore, bm25Rank),
    };
  };

  /**
   * Hybrid ranking starts as BM25. The graph is allowed one move: promote a
   * file that defines a named seed, sits in the BM25 top 8, and is close in
   * lexical score. When two names in the issue seed two files, prefer the one
   * covering tests actually exercise — that is impact, not another quoted word.
   * If that still ties, we do not guess — BM25 stands.
   */
  const PROMOTE_MIN_LEX = 0.82;
  const PROMOTE_MAX_RANK = 8;

  const evidenceFlags = (evidence: Evidence[]) => ({
    seedHit: evidence.some((item) => item.depth === 0 && item.relTypes.length === 0),
    callHit: evidence.some((item) => item.relTypes.includes(Edge.CALLS)),
    cochangeHit: evidence.some((item) => item.relTypes.includes(Edge.CO_CHANGES)),
  });

  const seedVias = (evidence: Evidence[]): string[] =>
    evidence.filter((item) => item.depth === 0 && item.relTypes.length === 0).map((item) => item.via);

  const displayGraph = (graph: number, evidence: Evidence[]): number => {
    const flags = evidenceFlags(evidence);
    return Math.min(
      1,
      (flags.seedHit ? 0.7 : 0) + (flags.callHit ? 0.25 * Math.min(1, graph) : 0) + (flags.cochangeHit ? 0.15 : 0),
    );
  };

  const lexicalRanked: RankedFile[] = lexicalOrder
    .slice(0, limit)
    .map(({ path, entry, graph }) =>
      toRanked(path, entry.lexical, displayGraph(graph, entry.evidence), entry.lexical, entry.evidence),
    );

  const candidates = lexicalRanked.filter((file) => {
    const source = combined.find((row) => row.path === file.path);
    if (!source) return false;
    const flags = evidenceFlags(source.entry.evidence);
    const rank = file.bm25Rank ?? 99;
    return flags.seedHit && rank >= 1 && rank <= PROMOTE_MAX_RANK && file.lexicalScore >= PROMOTE_MIN_LEX;
  });

  const covered = candidates.filter((file) => {
    const source = combined.find((row) => row.path === file.path);
    if (!source) return false;
    const vias = new Set(seedVias(source.entry.evidence));
    return tests.some((test) => vias.has(test.via));
  });

  // A named symbol alone is not enough to reorder a strong lexical result.
  // Promotion requires a single candidate whose seed also reaches covering
  // tests. When that corroboration is absent, keep BM25's order and attach the
  // graph evidence without pretending it is decisive.
  const promote = covered.length === 1 ? covered[0] : undefined;

  const hybrid: RankedFile[] = lexicalRanked.map((file) => ({ ...file, why: [...file.why] }));
  if (graphWeight > 0 && promote && (promote.bm25Rank ?? 1) >= 2) {
    const winner = hybrid.find((file) => file.path === promote.path);
    if (winner) {
      winner.score = 1.2;
      winner.why = [
        covered.length === 1
          ? "covering tests prove this named seed — HydraDB promoted it"
          : "named seed in this file, close behind word search — HydraDB promoted it",
        ...winner.why,
      ].slice(0, 4);
    }
    hybrid.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  const structural: RankedFile[] = combined
    .filter(({ graph }) => graph > 0)
    .map(({ path, entry, graph }) => {
      const graphScore = displayGraph(graph, entry.evidence);
      return toRanked(path, entry.lexical, graphScore, graphScore, entry.evidence);
    })
    .sort((a, b) => b.graphScore - a.graphScore || a.path.localeCompare(b.path))
    .slice(0, limit);

  const lexicalTop = new Set(lexicalRanked.map((file) => file.path));

  return {
    ranked: hybrid,
    lexical: lexicalRanked,
    structural,
    mentions,
    seeds: seeded,
    unresolved,
    tests: tests.slice(0, 20),
    traversal: {
      engine: "HydraDB algo.MSpaths",
      direction: "both",
      relTypes: [...SYMBOL_EDGES, ...FILE_EDGES],
      seedCount: seeded.length,
      pathCount: symbolPaths.length + filePaths.length,
      elapsedMs,
    },
    graphOnly: hybrid.filter((file) => !lexicalTop.has(file.path)).map((file) => file.path),
  };
}
