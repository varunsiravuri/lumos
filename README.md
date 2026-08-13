# Lumos

**Blast radius analysis for software supply chain compromises, built on a HydraDB graph.**

Built for [Hack Hydra](https://hackhydra.hydradb.com/) (Aug 12–20, 2026), Track 02 —
*Repos, Dependencies and Code as Graphs*, direction A.

---

## The problem

When a package is compromised at 09:00, which of your services are exposed by
09:06?

In the TanStack compromise, 84 malicious artifacts were published across 42
packages within six minutes of a CI pipeline being breached, and the worm went
on to reach more than 160 npm and PyPI packages. The defender's problem is
speed, and the question is a transitive reverse-dependency closure over an
ecosystem graph with tens of millions of versioned nodes.

Existing scanners answer a narrower question. They model your dependency tree,
flattened, at the moment you scan, and return a sorted list of advisories. Two
dimensions are missing from all of them, and both are graph-shaped:

- **The human graph.** Compromises spread through maintainer accounts and shared
  publishing infrastructure, not only through dependency edges. Tracing an
  incident sideways to packages that share a maintainer is a two-hop traversal.
- **Time.** The question after an incident is not "am I vulnerable now" but "was
  I ever, for how long, and what did I ship during that window". Every version
  has a publish timestamp and every lockfile has a commit timestamp, which makes
  exposure a temporal traversal.

## What Lumos does

- **Trace.** Given a compromised package, compute the full reverse-dependency
  closure with a traceable path through the graph for every exposed service.
- **Time-travel.** Reconstruct exposure as of any point in the past, so you can
  answer which builds resolved a malicious version while it was live.
- **Pivot.** Follow maintainer and publishing-infrastructure edges to the
  packages that are suspect because of who published them, not what they import.
- **Treat.** Compute the minimum set of upgrades that cuts the most exposed paths.

## Status

Early. The HydraDB integration and the core traversal are working and verified
end to end; ingestion and the product surface are in progress.

Run `pnpm probe` to see a compromised package resolve its blast radius, with
per-hop depth, against a live HydraDB node.

## Quickstart

Requires Docker, Node 20.11+ and pnpm.

```bash
git clone <this-repo> && cd lumos
cp .env.example .env      # then set HOST_UID / HOST_GID to `id -u` and `id -g`
pnpm install

pnpm db:up                # starts HydraDB, blocks until it answers a query
pnpm probe                # end-to-end blast radius check, prints `probe-ok`
```

`pnpm db:up` prints `hydradb-ok` once the node round-trips a real query. A
listening port is not proof the node works, so the script waits for a query
rather than for the port.

| Command | Purpose |
|---|---|
| `pnpm db:up` | Start HydraDB and wait until it is genuinely usable |
| `pnpm db:down` | Stop the node, keeping the store |
| `pnpm db:reset` | Destroy the local graph and start from empty |
| `pnpm db:logs` | Follow the node log |
| `pnpm probe` | End-to-end write, traverse and assert against HydraDB |
| `pnpm typecheck` | Typecheck the workspace |

The node listens on `7687` for Bolt, `8443` for the HTTP query API, and `9090`
for `/readyz` and Prometheus metrics.

## How Lumos uses HydraDB

HydraDB is not a store that Lumos happens to read from — it is where the
analysis happens. Remove it and there is no product left, only a downloader.

The central operation is a bounded reverse-dependency closure from a compromised
package across an ecosystem-scale graph, returning whole paths so every exposed
service comes with the chain that exposed it. That runs entirely inside HydraDB
through `algo.MSpaths` with `relDirection: 'incoming'`, seeded server-side from
many compromised packages at once to avoid client-side query fan-out.

This is the class of question a vector index cannot answer at all. Similarity has
nothing to say about which of your services transitively resolve a malicious
version, and a relational schema answers it only with recursive CTEs whose cost
grows badly with depth.

Two further pieces of HydraDB do real work. Snapshot-consistent reads give
point-in-time exposure a well-defined meaning, since every query runs against one
pinned snapshot. And GraphBLAS-backed sparse traversal over compiled adjacency is
what keeps the closure fast enough to be useful during an incident, which is the
entire premise of the product.

`docs/hydradb-constraints.md` records the engine constraints that shaped the data
model, each one verified against a running node.

## Repository layout

```
infra/              HydraDB development node (docker compose)
scripts/            Lifecycle and readiness scripts
packages/graph/     HydraDB client, value decoding, traversal primitives
docs/               Engine constraints and design notes
```

## Attribution

- [HydraDB](https://github.com/hydra-db/hydradb), AGPL-3.0 — the graph database
  Lumos is built on. Lumos communicates with it over its HTTP and Bolt APIs as a
  separate program and does not link against or vendor its source.

Data sources and datasets will be credited here as they are integrated.

## License

MIT. See [LICENSE](./LICENSE).
