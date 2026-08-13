# HydraDB constraints that shape Lumos

Everything here was verified against `ghcr.io/hydra-db/hydradb:latest` on the
local development node, not inferred from documentation. The upstream reference
is [`cypher-compat.md`](https://github.com/hydra-db/hydradb/blob/main/cypher-compat.md);
this file records the consequences for our data model.

HydraDB implements a deliberate subset of OpenCypher, shaped by what an
object-store-native engine can execute efficiently. The subset is narrow in
places that matter to us, and the design response is consistent: **precompute
structure into nodes and edges at ingest time, because query-time expressiveness
is limited.** That suits a dependency graph well.

## Identity

Nodes are identified by a non-negative integer `id`, and that `id` *is* the
identity the engine matches on. Two consequences:

- `id` is not a normal property. `MATCH (n {id: 999999}) RETURN n.id` returns a
  row for a node that was never created, because the pattern resolves directly
  to a vertex id instead of testing for existence. Never model a domain
  identifier as `id`; use `name`, `purl`, `version` and check existence with a
  label or property predicate.
- Every entity needs a deterministic integer id assigned before it is written.
  Package names, versions and maintainer handles are strings, so Lumos owns the
  string-to-id mapping.

Relationships need explicit integer ids too. Batch `CREATE` rejects a
relationship whose properties do not include `id: row.<field>`.

## Reads

`MATCH` requires a predicate. A bare `MATCH (n)` is rejected with "node-only
MATCH requires an id, label, or property predicate", so **every node must carry
a label**. A bare `RETURN 1` is also rejected: the row executor only runs
`MATCH ... RETURN`.

**Variable-length `MATCH` requires a fixed source id.** This is the single most
important constraint for Lumos. A reverse-dependency closure written the obvious
way is rejected:

```cypher
-- rejected: "variable-length MATCH requires a fixed source id"
MATCH (s:Package)-[:DEPENDS_ON*1..5]->(t {id: $compromised}) RETURN s.name
```

Closures that terminate at a known node must instead seed at that node and walk
backwards through a path procedure, which is what `packages/graph/src/traverse.ts`
does. Traversal depth must always be bounded; `*` and `*1..` are rejected because
unbounded traversal has no predictable cost.

A relationship pattern carries exactly one type and a direction. Undirected
patterns and multi-type patterns such as `[:DEPENDS_ON|RESOLVES_TO]` are
rejected, so a traversal that needs to cross edge kinds needs either several
queries or a single materialised edge type.

`WHERE` supports boolean combinations of property comparisons using `=`, `<>`,
`<`, `>`, `<=`, `>=` and `STARTS WITH`. **`IN`, `CONTAINS`, `ENDS WITH` and
`IS NULL` are not supported.** So:

- Set membership is done with `UNWIND`, or with `sourceValues` on a path procedure.
- Typosquat detection cannot use string distance at query time. Candidate pairs
  are computed during ingest and materialised as `TYPOSQUAT_OF` edges, which is
  the graph-native form anyway.

Aggregates are limited to `count`, `sum`, `avg` and `collect` — there is no `min`
or `max`, and `WITH` is pass-through only, with no aliasing, filtering or
ordering. Multi-stage aggregation pipelines belong in application code.

Property values are integers, floats, booleans and strings. There are no list
properties, so ordered version data needs a numeric sort key alongside the
version string.

## Path procedures

`algo.SPpaths`, `algo.SSpaths` and `algo.MSpaths` are the only way to get whole
paths back rather than endpoint projections, and they are how Lumos computes
blast radius:

```cypher
CALL algo.MSpaths({
  sourceLabel: 'Package', sourceProperty: 'name', sourceValues: ['color-name'],
  relTypes: ['DEPENDS_ON'], relDirection: 'incoming',
  maxLen: 5, pathCount: 1000, resultLimit: 10000
}) YIELD path RETURN path
```

- `relDirection` must be `'incoming'`, `'outgoing'` or `'both'`. `'in'` and
  `'out'` are parse errors.
- **Set `pathCount` explicitly.** The default is low enough that a closure comes
  back with a single path and looks far smaller than it is.
- `sourceValues` resolves many seeds server-side, which avoids client-side query
  fan-out when a compromise spans dozens of packages.
- `RETURN` may only name yielded columns: `path`, `pathWeight`, `pathCost`.

## Writes

Writes commit to object storage, so a statement is durable when it returns.

Batch writes go through `UNWIND` with a parameter holding a list of maps; an
inline literal list is rejected. A vertex upsert must be `MERGE` by id followed
by `SET` — folding properties into the `MERGE` pattern rewrites the thing being
matched and is rejected.

```cypher
UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Package, n.name = row.name

UNWIND $rows AS row
  MATCH (s:Package {id: row.src}), (d:Package {id: row.dst})
  CREATE (s)-[:DEPENDS_ON {id: row.rel, range: row.range}]->(d)
```

`UNWIND MATCH ... CREATE` writes nothing for rows whose endpoints do not match,
and reports success either way, so nodes must be loaded before edges and edge
counts should be verified after a load.

## Transport and API

The HTTP query API is `POST /v1/graphs/{graph}/query`, with `cell_id` required
and query arguments under **`parameters`**. A `params` key is silently ignored
and the query then fails with "missing OpenCypher query parameter". Unknown
fields are accepted without complaint, so a misspelled option fails quietly.

Only one statement per request is accepted.

Batches run through the client transport, because a parameter holding a list of
maps is a transport-level type. The in-process shard API takes scalar parameters
only and rejects every `UNWIND` form, with a message about row execution rather
than batching — the statement is fine, the entry point is wrong.

## Operational

- `RUST_MIN_STACK=33554432` is mandatory. Without it `graph-node` serves
  `/readyz` and then aborts on the first query.
- `LOCAL_PATH` must point at a directory that already exists.
- The image runs as UID/GID 10001 while bind mounts are host-owned, so the
  container has to run as the host user or the first storage operation fails.
- The image ships only `sh`, with no `curl`, `wget` or `nc`, so container
  healthchecks cannot probe the node. Readiness is checked from the host by
  `scripts/wait-for-hydradb.sh`.
- A listening port is not proof the node works. Readiness means a round-tripped
  query.
