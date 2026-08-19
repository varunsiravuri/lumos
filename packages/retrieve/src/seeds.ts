/**
 * Turn the names an issue mentions into nodes the graph can be seeded from.
 *
 * Two things happen here that a text index cannot do. A path written in a
 * traceback is matched against the files that actually exist, so a machine's
 * absolute path collapses onto the repository-relative one. And a bare symbol
 * name is looked up in the graph and weighted by how many definitions answer to
 * it: `set_cookie` resolves to two symbols and is worth following, `save`
 * resolves to thirty-two and is worth almost nothing.
 *
 * That second number is inverse document frequency computed over the code
 * itself rather than over prose, and it is the difference between seeding a
 * traversal at the right function and seeding it everywhere at once.
 */

import type { HydraClient } from "@lumos/graph";
import { Label, ukey } from "@lumos/graph";

import type { Mention } from "./mentions.ts";

export interface Seed {
  /** The seedable unique key, matching `UKEY_PROPERTY` on the node. */
  ukey: string;
  label: typeof Label.File | typeof Label.Symbol;
  /** Repository-relative path of the node, or of the file defining the symbol. */
  path: string;
  weight: number;
  /** The mention text this came from, for explaining a result. */
  via: string;
}

/**
 * A name shared by many definitions is not walked everywhere. BM25 picks which
 * files are plausible, and only those definitions become seeds.
 */
/** Cap on how many definitions of one name we will even consider. */
const LOOKUP_CAP = 32;

/** After BM25 disambiguation, walk at most this many. */
const MAX_AMBIGUITY = 4;

/** Symbol lookups issued at once. The queries are small; the round trips are not. */
const CONCURRENCY = 12;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );

  return results;
}

/**
 * Match a path mention against the files that exist, longest suffix first.
 *
 * Issues quote paths in every shape: repository-relative, absolute from a
 * developer's machine, or prefixed by a site-packages directory. Matching on
 * the longest shared suffix handles all three, and requiring the match to be at
 * a directory boundary stops `models.py` from selecting `custom_models.py`.
 */
export function resolvePath(mention: string, files: readonly string[]): string[] {
  const normalized = mention.replace(/\\/g, "/").replace(/^\.\//, "");

  const exact = files.filter((file) => file === normalized);
  if (exact.length > 0) return exact;

  const suffix = files.filter((file) => file.endsWith(`/${normalized}`));
  if (suffix.length > 0) return suffix;

  // An absolute path from someone else's machine must not collapse to the
  // bare filename. `utils.py` is half the standard library.
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    for (let take = Math.min(parts.length, 4); take >= 2; take -= 1) {
      const tail = parts.slice(-take).join("/");
      const matched = files.filter((file) => file === tail || file.endsWith(`/${tail}`));
      if (matched.length > 0) return matched;
    }
    return [];
  }

  const base = parts[0] ?? normalized;
  return files.filter((file) => file === base || file.endsWith(`/${base}`));
}

export interface SymbolHit {
  qualname: string;
  path: string;
  kind: string;
  isTest: boolean;
}

/** Every definition in `repo` answering to a bare name, capped. */
async function lookupSymbol(
  client: HydraClient,
  repo: string,
  name: string,
  limit: number,
): Promise<SymbolHit[]> {
  const result = await client.query(
    `MATCH (s:${Label.Symbol} {name: $name, repo: $repo}) ` +
      `RETURN s.qualname AS qualname, s.path AS path, s.kind AS kind, s.is_test AS isTest ` +
      `LIMIT ${limit}`,
    { parameters: { name, repo } },
  );

  return result.rows.map((row) => ({
    qualname: String(row.qualname ?? ""),
    path: String(row.path ?? ""),
    kind: String(row.kind ?? ""),
    isTest: row.isTest === true || row.isTest === "true",
  }));
}

/** A dotted mention may be the tail of a qualname; try it as a suffix of one. */
async function lookupQualnameTail(
  client: HydraClient,
  repo: string,
  chain: string,
  limit: number,
): Promise<SymbolHit[]> {
  const name = chain.slice(chain.lastIndexOf(".") + 1);
  const hits = await lookupSymbol(client, repo, name, limit * 4);
  const parent = chain.slice(0, chain.lastIndexOf("."));

  // `WHERE ... ENDS WITH` is unsupported, so the qualified form is filtered on
  // the client after resolving the bare tail.
  const qualified = hits.filter((hit) => hit.qualname.endsWith(`.${chain}`) || hit.qualname === chain);
  if (qualified.length > 0) return qualified.slice(0, limit);

  return hits.filter((hit) => hit.qualname.includes(`.${parent}.`)).slice(0, limit);
}

export interface ResolveOptions {
  repo: string;
  /** Every file in the repository, used to anchor path mentions. */
  files: readonly string[];
  maxSymbolMentions?: number;
  /**
   * Files BM25 already likes, best first. A name like `join` has too many
   * definitions to walk; the lexical ranking is used to pick which ones.
   * BM25 finds likely names. The graph then proves impact from those names.
   */
  lexicalPrior?: readonly string[];
}

export interface Resolution {
  seeds: Seed[];
  /** Mentions that matched nothing, kept so a run can be explained. */
  /** Mentions that matched nothing, kept so a run can be explained. */
  unresolved: string[];
}

export async function resolveSeeds(
  client: HydraClient,
  mentions: Mention[],
  options: ResolveOptions,
): Promise<Resolution> {
  const { repo, files, maxSymbolMentions = 24, lexicalPrior = [] } = options;
  const priorRank = new Map(lexicalPrior.map((path, index) => [path, index]));

  const seeds = new Map<string, Seed>();
  const unresolved: string[] = [];

  const keep = (seed: Seed): void => {
    const existing = seeds.get(seed.ukey);
    if (!existing || seed.weight > existing.weight) seeds.set(seed.ukey, seed);
  };

  for (const mention of mentions.filter((m) => m.kind === "path")) {
    const matched = resolvePath(mention.text, files);
    if (matched.length === 0) {
      unresolved.push(mention.text);
      continue;
    }
    // Spreading the weight keeps an ambiguous filename from outweighing an
    // exact path, without discarding it.
    const share = mention.weight / Math.sqrt(matched.length);
    for (const path of matched) {
      keep({ ukey: ukey.file(repo, path), label: Label.File, path, weight: share, via: mention.text });
    }
  }

  const symbolMentions = mentions.filter((m) => m.kind === "symbol").slice(0, maxSymbolMentions);

  const hits = await mapLimit(symbolMentions, CONCURRENCY, async (mention) =>
    mention.text.includes(".")
      ? [mention, await lookupQualnameTail(client, repo, mention.text, LOOKUP_CAP)] as const
      : [mention, await lookupSymbol(client, repo, mention.text, LOOKUP_CAP)] as const,
  );

  for (const [mention, matched] of hits) {
    if (matched.length === 0) {
      unresolved.push(mention.text);
      continue;
    }

    const live = matched.filter((hit) => !hit.isTest);
    if (live.length === 0) continue;

    // Ambiguous names are not discarded outright. BM25 already ranked files;
    // keep the definitions that live in those files and drop the rest.
    let chosen = live;
    if (live.length > MAX_AMBIGUITY) {
      const preferred = live
        .filter((hit) => priorRank.has(hit.path))
        .sort((a, b) => (priorRank.get(a.path) ?? 0) - (priorRank.get(b.path) ?? 0));
      if (preferred.length === 0) continue;
      chosen = preferred.slice(0, MAX_AMBIGUITY);
    }

    const share = mention.weight / Math.sqrt(chosen.length);
    for (const hit of chosen) {
      keep({
        ukey: ukey.symbol(repo, hit.qualname),
        label: Label.Symbol,
        path: hit.path,
        weight: share,
        via: mention.text,
      });
    }
  }

  return {
    seeds: [...seeds.values()].sort((a, b) => b.weight - a.weight),
    unresolved,
  };
}
