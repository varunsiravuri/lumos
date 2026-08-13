/**
 * The Lumos code graph.
 *
 * Shaped by two HydraDB constraints (see docs/hydradb-constraints.md):
 *
 * 1. Nodes are identified by integer `id`, and `id` is the engine's own identity
 *    rather than a property. Every domain identifier here is therefore a string
 *    that the id registry maps to an integer before anything is written.
 * 2. A traversal seeds through `sourceLabel` + `sourceProperty` + `sourceValues`,
 *    so every seedable node carries a `ukey`: a single string property, unique
 *    across repositories, that a query can resolve without a join.
 */

export const Label = {
  /** A repository at a pinned commit. */
  Repo: "Repo",
  /** A source file within a repository. */
  File: "File",
  /** A function, method or class definition. */
  Symbol: "Symbol",
} as const;

export type Label = (typeof Label)[keyof typeof Label];

export const Edge = {
  /** Repo -> File */
  CONTAINS: "CONTAINS",
  /** File -> Symbol */
  DEFINES: "DEFINES",
  /** Symbol -> Symbol, a resolved call site. */
  CALLS: "CALLS",
  /** File -> File, a resolved module import. */
  IMPORTS: "IMPORTS",
  /** Symbol -> Symbol, a test exercising a symbol. Derived from CALLS. */
  COVERS: "COVERS",
  /** File -> File, weighted by how often the two are revised in one commit. */
  CO_CHANGES: "CO_CHANGES",
} as const;

export type Edge = (typeof Edge)[keyof typeof Edge];

/**
 * Edge types walked when answering "what is affected by changing this".
 *
 * A MATCH pattern accepts only one relationship type, but the path procedures
 * accept several through `relTypes`, which is why impact analysis is expressed
 * as a procedure call rather than a pattern.
 */
export const IMPACT_EDGES: Edge[] = [Edge.CALLS, Edge.COVERS];

export type SymbolKind = "function" | "method" | "class";

export interface RepoNode {
  /** Owner and name, e.g. "django/django". */
  slug: string;
  /** The commit the graph was built from. */
  commit: string;
}

export interface FileNode {
  /** Repository-relative path, e.g. "django/http/response.py". */
  path: string;
  repo: string;
  language: string;
  loc: number;
  isTest: boolean;
}

export interface SymbolNode {
  /** Module-qualified name within the repo, e.g. "django.http.response.HttpResponse.set_cookie". */
  qualname: string;
  /** Bare name for display, e.g. "set_cookie". */
  name: string;
  kind: SymbolKind;
  repo: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  isTest: boolean;
}

/**
 * Keys handed to the id registry. Every key is prefixed by its kind so that a
 * file and a symbol sharing a name can never collide.
 */
export const key = {
  repo: (slug: string): string => `repo\u0000${slug}`,
  file: (repo: string, path: string): string => `file\u0000${repo}\u0000${path}`,
  symbol: (repo: string, qualname: string): string => `sym\u0000${repo}\u0000${qualname}`,
  edge: (type: Edge, src: number, dst: number): string => `edge\u0000${type}\u0000${src}\u0000${dst}`,
};

/**
 * `ukey` is the seedable, globally unique string form of a node. It is stored on
 * the node and is what `sourceValues` matches against, so it must be derivable
 * on the query side from a repo plus a path or qualname.
 */
export const ukey = {
  repo: (slug: string): string => slug,
  file: (repo: string, path: string): string => `${repo}#${path}`,
  symbol: (repo: string, qualname: string): string => `${repo}#${qualname}`,
};

/** Property name carrying the seedable unique key on File and Symbol nodes. */
export const UKEY_PROPERTY = "ukey";
