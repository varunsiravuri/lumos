/**
 * Answer "what breaks if I change this symbol".
 *
 * Seed at the symbol, walk CALLS and COVERS backwards. Incoming is required:
 * HydraDB rejects a variable-length MATCH that ends at a known id, so the
 * closure is expressed as a path procedure seeded at the target.
 */

import type { HydraClient } from "@lumos/graph";
import { closure, Edge, Label, reachedNodes, ukey, UKEY_PROPERTY } from "@lumos/graph";
import type { ReachedNode } from "@lumos/graph";

export interface ImpactHit {
  qualname: string;
  path: string;
  kind: string;
  isTest: boolean;
  depth: number;
}

/** A call or cover from `from` to `to`, taken off the HydraDB paths. */
export interface ImpactEdge {
  from: string;
  to: string;
  type: string;
}

export interface ImpactResult {
  seed: { qualname: string; path: string; kind: string };
  elapsedMs: number;
  pathCount: number;
  symbols: ImpactHit[];
  tests: ImpactHit[];
  edges: ImpactEdge[];
}

async function resolveSymbol(
  client: HydraClient,
  repo: string,
  query: string,
  eligible?: Set<string>,
): Promise<{ qualname: string; path: string; kind: string } | null> {
  const choose = (rows: Awaited<ReturnType<HydraClient["query"]>>["rows"]) => {
    const scoped = eligible ? rows.filter((row) => eligible.has(String(row.path ?? ""))) : rows;
    return scoped.find((row) => !String(row.path ?? "").includes("/tests/")) ?? scoped[0];
  };
  const asUkey = query.includes("#") ? query : ukey.symbol(repo, query);

  const exact = await client.query(
    `MATCH (s:${Label.Symbol} {ukey: $ukey}) ` +
      `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 1`,
    { parameters: { ukey: asUkey } },
  );
  const hit = choose(exact.rows);
  if (hit) {
    return {
      qualname: String(hit.qualname ?? ""),
      path: String(hit.path ?? ""),
      kind: String(hit.kind ?? ""),
    };
  }

  const byQualname = await client.query(
    `MATCH (s:${Label.Symbol} {qualname: $qualname, repo: $repo}) ` +
      `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 64`,
    { parameters: { qualname: query.replace(`${repo}#`, ""), repo } },
  );
  const qualified = choose(byQualname.rows);
  if (qualified) {
    return {
      qualname: String(qualified.qualname ?? ""),
      path: String(qualified.path ?? ""),
      kind: String(qualified.kind ?? ""),
    };
  }

  const byName = await client.query(
    `MATCH (s:${Label.Symbol} {name: $name, repo: $repo}) ` +
      `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind LIMIT 64`,
    { parameters: { name: query, repo } },
  );
  const row = choose(byName.rows);
  if (!row) return null;
  return {
    qualname: String(row.qualname ?? ""),
    path: String(row.path ?? ""),
    kind: String(row.kind ?? ""),
  };
}

function toHit(node: ReachedNode): ImpactHit {
  return {
    qualname: String(node.properties.qualname ?? ""),
    path: String(node.properties.path ?? ""),
    kind: String(node.properties.kind ?? ""),
    isTest: node.properties.is_test === true || node.properties.is_test === "true",
    depth: node.depth,
  };
}

export async function impact(
  client: HydraClient,
  options: { repo: string; symbol: string; maxHops?: number; files?: readonly string[] },
): Promise<ImpactResult | null> {
  const eligible = options.files ? new Set(options.files) : undefined;
  const seed = await resolveSymbol(client, options.repo, options.symbol, eligible);
  if (!seed) return null;

  const started = Date.now();
  const paths = await closure(client, {
    label: Label.Symbol,
    property: UKEY_PROPERTY,
    values: [ukey.symbol(options.repo, seed.qualname)],
    relTypes: [Edge.CALLS, Edge.COVERS],
    direction: "incoming",
    maxLen: options.maxHops ?? 4,
    pathCount: 4000,
    resultLimit: 40_000,
  });
  const elapsedMs = Date.now() - started;

  const hits = reachedNodes(paths)
    .filter((node) => node.labels.includes(Label.Symbol))
    .map(toHit)
    .filter((hit) => hit.qualname.length > 0);
  if (!hits.some((hit) => hit.qualname === seed.qualname && hit.path === seed.path)) {
    hits.unshift({ ...seed, isTest: false, depth: 0 });
  }

  const edgeKeys = new Set<string>();
  const edges: ImpactEdge[] = [];
  for (const path of paths) {
    for (let index = 0; index < path.relationships.length; index += 1) {
      const src = path.nodes[index];
      const dst = path.nodes[index + 1];
      if (!src || !dst) continue;
      const from = String(dst.properties.qualname ?? "");
      const to = String(src.properties.qualname ?? "");
      if (!from || !to) continue;
      const type = path.relationships[index]!.type;
      const key = `${from}\u0000${to}\u0000${type}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from, to, type });
    }
  }

  return {
    seed,
    elapsedMs,
    pathCount: paths.length,
    symbols: hits.filter((hit) => !hit.isTest),
    tests: hits.filter((hit) => hit.isTest),
    edges,
  };
}
