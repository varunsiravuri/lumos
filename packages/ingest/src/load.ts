import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { Edge, key, Label, ukey, type HydraClient, type EdgeRow, type NodeRow } from "@lumos/graph";

import type { IdRegistry } from "./ids.ts";

interface RepoRecord { t: "repo"; slug: string; commit: string }
interface FileRecord { t: "file"; path: string; language: string; loc: number; is_test: boolean }
interface SymbolRecord {
  t: "symbol";
  qualname: string;
  name: string;
  kind: string;
  path: string;
  line_start: number;
  line_end: number;
  is_test: boolean;
}
interface CallRecord { t: "call"; src: string; dst: string; line: number }
interface ImportRecord { t: "import"; src: string; dst: string }
interface CochangeRecord { t: "cochange"; src: string; dst: string; commits: number; strength: number }
interface StatsRecord { t: "stats"; [metric: string]: number | string }

type Record_ =
  | RepoRecord
  | FileRecord
  | SymbolRecord
  | CallRecord
  | ImportRecord
  | CochangeRecord
  | StatsRecord;

export interface LoadReport {
  repo: string;
  nodes: { repos: number; files: number; symbols: number };
  edges: {
    contains: number;
    defines: number;
    calls: number;
    imports: number;
    covers: number;
    cochanges: number;
  };
  /** Call and import edges whose endpoints were not in the extraction. */
  danglingEdges: number;
  extractorStats: Record<string, number | string>;
  elapsedMs: number;
  nodesPerSecond: number;
  edgesPerSecond: number;
}

async function readRecords(paths: string[]): Promise<Record_[]> {
  const records: Record_[] = [];
  for (const path of paths) {
    const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of stream) {
      if (line.length > 0) records.push(JSON.parse(line) as Record_);
    }
  }
  return records;
}

/**
 * Load an extraction into HydraDB.
 *
 * Nodes are written before edges because `UNWIND MATCH ... MERGE` silently
 * writes nothing for rows whose endpoints do not exist and still reports
 * success, so a wrong order produces an empty graph and no error. Anything that
 * still fails to resolve is counted and reported rather than dropped quietly.
 */
export async function loadExtraction(
  client: HydraClient,
  registry: IdRegistry,
  extractionPaths: string[],
  options: { chunkSize?: number; onProgress?: (message: string) => void } = {},
): Promise<LoadReport> {
  const chunkSize = options.chunkSize ?? 1000;
  const progress = options.onProgress ?? (() => {});
  const started = performance.now();

  const records = await readRecords(extractionPaths);
  progress(`read ${records.length.toLocaleString()} records`);

  const repoRecord = records.find((r): r is RepoRecord => r.t === "repo");
  if (!repoRecord) throw new Error(`${extractionPaths.join(", ")} has no repo record`);
  const repo = repoRecord.slug;

  const files = records.filter((r): r is FileRecord => r.t === "file");
  const symbols = records.filter((r): r is SymbolRecord => r.t === "symbol");
  const calls = records.filter((r): r is CallRecord => r.t === "call");
  const imports = records.filter((r): r is ImportRecord => r.t === "import");
  const cochanges = records.filter((r): r is CochangeRecord => r.t === "cochange");
  const extractorStats = records.find((r): r is StatsRecord => r.t === "stats") ?? { t: "stats" };

  // --- ids -----------------------------------------------------------------

  const nodeKeys: string[] = [key.repo(repo)];
  for (const file of files) nodeKeys.push(key.file(repo, file.path));
  for (const symbol of symbols) nodeKeys.push(key.symbol(repo, `${symbol.path}#${symbol.qualname}`));

  const ids = registry.allocate(nodeKeys);
  const repoId = ids.get(key.repo(repo))!;
  const fileId = (path: string): number | undefined => ids.get(key.file(repo, path));
  const symbolId = (path: string, qualname: string): number | undefined =>
    ids.get(key.symbol(repo, `${path}#${qualname}`));

  // One node per (file, qualname). A qualname can legitimately be defined twice
  // in a file — a property getter and its setter share a name — and HydraDB
  // rejects a batch that sets conflicting values for one vertex, so the earliest
  // definition wins and the collision is counted rather than hidden.
  const uniqueSymbols = new Map<number, SymbolRecord>();
  let duplicateSymbols = 0;
  for (const symbol of symbols) {
    const id = symbolId(symbol.path, symbol.qualname);
    if (id === undefined) continue;
    const existing = uniqueSymbols.get(id);
    if (!existing) {
      uniqueSymbols.set(id, symbol);
    } else {
      duplicateSymbols += 1;
      if (symbol.line_start < existing.line_start) uniqueSymbols.set(id, symbol);
    }
  }

  // A qualname can be defined in more than one file, so calls resolve through a
  // qualname index rather than assuming a single definition site.
  const byQualname = new Map<string, number[]>();
  const isTestSymbol = new Map<number, boolean>();
  for (const [id, symbol] of uniqueSymbols) {
    const bucket = byQualname.get(symbol.qualname);
    if (bucket) bucket.push(id);
    else byQualname.set(symbol.qualname, [id]);
    isTestSymbol.set(id, symbol.is_test);
  }

  progress(
    `allocated ${ids.size.toLocaleString()} node ids` +
      (duplicateSymbols > 0 ? ` (${duplicateSymbols.toLocaleString()} duplicate definitions collapsed)` : ""),
  );

  // --- nodes ---------------------------------------------------------------

  const repoRows: NodeRow[] = [
    { vertex: repoId, ukey: ukey.repo(repo), slug: repo, commit: repoRecord.commit },
  ];

  const fileRows: NodeRow[] = files.map((file) => ({
    vertex: fileId(file.path)!,
    ukey: ukey.file(repo, file.path),
    path: file.path,
    repo,
    language: file.language,
    loc: file.loc,
    is_test: file.is_test,
  }));

  const symbolRows: NodeRow[] = [...uniqueSymbols].map(([vertex, symbol]) => ({
    vertex,
    ukey: ukey.symbol(repo, symbol.qualname),
    qualname: symbol.qualname,
    name: symbol.name,
    kind: symbol.kind,
    repo,
    path: symbol.path,
    line_start: symbol.line_start,
    line_end: symbol.line_end,
    is_test: symbol.is_test,
  }));

  await client.upsertNodes(Label.Repo, repoRows, chunkSize);
  await client.upsertNodes(Label.File, fileRows, chunkSize);
  progress(`wrote ${fileRows.length.toLocaleString()} files`);
  await client.upsertNodes(Label.Symbol, symbolRows, chunkSize);
  progress(`wrote ${symbolRows.length.toLocaleString()} symbols`);

  // --- edges ---------------------------------------------------------------

  let dangling = 0;

  // Allocating edge ids one at a time would mean a SQLite transaction per edge,
  // so every id for a given type is allocated in one call first.
  const allocateEdgeIds = (type: Edge, pairs: [number, number][]): Map<string, number> =>
    registry.allocate(pairs.map(([src, dst]) => key.edge(type, src, dst)));

  const buildRows = (
    type: Edge,
    pairs: [number, number][],
    extras: Record<string, number>[] = [],
  ): EdgeRow[] => {
    const edgeIds = allocateEdgeIds(type, pairs);
    return pairs.map(([src, dst], index) => ({
      src,
      dst,
      rel: edgeIds.get(key.edge(type, src, dst))!,
      ...(extras[index] ?? {}),
    }));
  };

  const containsPairs: [number, number][] = files
    .map((file) => fileId(file.path))
    .filter((id): id is number => id !== undefined)
    .map((id) => [repoId, id]);

  const definesPairs: [number, number][] = [...uniqueSymbols]
    .map(([id, symbol]): [number | undefined, number] => [fileId(symbol.path), id])
    .filter((pair): pair is [number, number] => pair[0] !== undefined);

  /**
   * One edge per (source, target). A batch that sets two different values for
   * the same relationship is rejected, and `a` calling `b` on several lines is
   * ordinary. The first call site is kept and the rest become a count, which is
   * more useful than an arbitrary line anyway.
   */
  const callSites = new Map<string, { src: number; dst: number; line: number; count: number }>();
  const coversPairsSet = new Set<string>();

  for (const call of calls) {
    const sources = byQualname.get(call.src);
    const targets = byQualname.get(call.dst);
    if (!sources || !targets) {
      dangling += 1;
      continue;
    }
    for (const src of sources) {
      for (const dst of targets) {
        if (src === dst) continue;
        const pairKey = `${src}\u0000${dst}`;
        const existing = callSites.get(pairKey);
        if (existing) {
          existing.count += 1;
          existing.line = Math.min(existing.line, call.line);
        } else {
          callSites.set(pairKey, { src, dst, line: call.line, count: 1 });
        }
        // A test calling a symbol is coverage, which is a different question
        // from a call and deserves its own edge type to traverse.
        if (isTestSymbol.get(src) && !isTestSymbol.get(dst)) coversPairsSet.add(pairKey);
      }
    }
  }

  const callPairs: [number, number][] = [];
  const callExtras: Record<string, number>[] = [];
  for (const site of callSites.values()) {
    callPairs.push([site.src, site.dst]);
    callExtras.push({ line: site.line, call_sites: site.count });
  }

  const coversPairs: [number, number][] = [...coversPairsSet].map((pairKey) => {
    const [src, dst] = pairKey.split("\u0000");
    return [Number(src), Number(dst)];
  });

  const importSet = new Set<string>();
  for (const record of imports) {
    const src = fileId(record.src);
    const dst = fileId(record.dst);
    if (src === undefined || dst === undefined) {
      dangling += 1;
      continue;
    }
    importSet.add(`${src}\u0000${dst}`);
  }
  const importPairs: [number, number][] = [...importSet].map((pairKey) => {
    const [src, dst] = pairKey.split("\u0000");
    return [Number(src), Number(dst)];
  });

  // Co-change is symmetric, and the miner emits one canonical direction per
  // pair. Queries walk it with relDirection 'both' rather than the graph
  // storing each pair twice, which would double every path through it.
  const cochangePairs: [number, number][] = [];
  const cochangeExtras: Record<string, number>[] = [];
  const seenCochange = new Set<string>();

  for (const record of cochanges) {
    const src = fileId(record.src);
    const dst = fileId(record.dst);
    if (src === undefined || dst === undefined) {
      dangling += 1;
      continue;
    }
    const pairKey = `${src}\u0000${dst}`;
    if (seenCochange.has(pairKey)) continue;
    seenCochange.add(pairKey);
    cochangePairs.push([src, dst]);
    cochangeExtras.push({ commits: record.commits, strength: record.strength });
  }

  await client.mergeEdges(Edge.CONTAINS, Label.Repo, Label.File, buildRows(Edge.CONTAINS, containsPairs), chunkSize);
  await client.mergeEdges(Edge.DEFINES, Label.File, Label.Symbol, buildRows(Edge.DEFINES, definesPairs), chunkSize);
  progress(`wrote ${(containsPairs.length + definesPairs.length).toLocaleString()} structure edges`);

  await client.mergeEdges(Edge.CALLS, Label.Symbol, Label.Symbol, buildRows(Edge.CALLS, callPairs, callExtras), chunkSize);
  progress(`wrote ${callPairs.length.toLocaleString()} call edges`);

  await client.mergeEdges(Edge.IMPORTS, Label.File, Label.File, buildRows(Edge.IMPORTS, importPairs), chunkSize);
  await client.mergeEdges(Edge.COVERS, Label.Symbol, Label.Symbol, buildRows(Edge.COVERS, coversPairs), chunkSize);
  progress(`wrote ${importPairs.length.toLocaleString()} import and ${coversPairs.length.toLocaleString()} coverage edges`);

  await client.mergeEdges(
    Edge.CO_CHANGES,
    Label.File,
    Label.File,
    buildRows(Edge.CO_CHANGES, cochangePairs, cochangeExtras),
    chunkSize,
  );
  if (cochangePairs.length > 0) {
    progress(`wrote ${cochangePairs.length.toLocaleString()} co-change edges`);
  }

  const elapsedMs = performance.now() - started;
  const nodeCount = repoRows.length + fileRows.length + symbolRows.length;
  const edgeCount =
    containsPairs.length +
    definesPairs.length +
    callPairs.length +
    importPairs.length +
    coversPairs.length +
    cochangePairs.length;

  const { t: _tag, ...stats } = extractorStats;

  return {
    repo,
    nodes: { repos: repoRows.length, files: fileRows.length, symbols: symbolRows.length },
    edges: {
      contains: containsPairs.length,
      defines: definesPairs.length,
      calls: callPairs.length,
      imports: importPairs.length,
      covers: coversPairs.length,
      cochanges: cochangePairs.length,
    },
    danglingEdges: dangling,
    extractorStats: stats,
    elapsedMs,
    nodesPerSecond: nodeCount / (elapsedMs / 1000),
    edgesPerSecond: edgeCount / (elapsedMs / 1000),
  };
}
