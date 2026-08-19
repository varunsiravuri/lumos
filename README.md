# Lumos

**Lumos is the preflight and verification layer for coding agents.** Before an
agent edits, it turns one request into a small set of files, the graph paths that
justify them, and the tests that protect the change. After the edit, Patch Guard
checks whether the agent touched the proved target, stayed inside the investigated
scope, and reported a connected test.

> BM25 finds likely names. HydraDB proves impact.

Built for [Hack Hydra](https://hackhydra.hydradb.com/) (Aug 12–20, 2026), Track 02B —
code graphs for IDE assistants.

---

## The problem

Every IDE assistant embeds a repository and retrieves chunks by similarity.
Similarity is a weak proxy for relevance, and it fails in a specific, predictable
way: it returns code that *reads like* the question instead of code that the
change actually depends on.

What an engineer needs when fixing a bug is not similar code. It's the blast
radius of the change — what calls this function, what it calls in turn, where the
type is defined, which tests exercise it, and which config wires it up. None of
that is a similarity relationship. All of it is a traversal.

Three things are missing from similarity-based retrieval, and each one is an edge
in a graph:

- **Call structure.** Who calls this, transitively, and who does it call. A
  cosine distance between two chunks cannot express "reaches."
- **Tests and configuration.** The track brief names these specifically because
  everyone skips them. Which test covers a symbol tells an agent what to run;
  which config constructs a service is the context that is always absent.
- **History.** Two files with no import between them and no textual resemblance
  that changed together in forty of the last fifty commits are coupled. That
  coupling is invisible to an embedding and invisible to the parser, but it is
  strongly predictive of what a fix will touch.

## What Lumos does

- **Impact analysis as retrieval.** Seed at the symbols a question mentions, walk
  callers, callees, definitions, tests and config outward with bounded depth, and
  return the files a change actually needs.
- **Co-change coupling.** Mine git history into weighted edges between files that
  are revised together, surfacing relationships no parser or embedding can see.
- **Provable relevance.** Every retrieved file arrives with the path that
  justified it — "included because `handle_request` calls `validate_token` at
  line 88, and this test covers it." An embedding can never explain itself.
- **Measured against the real baseline.** SWE-bench instances ship the gold patch
  for each issue, so retrieval is scored offline against the files the real fix
  touched, versus a BM25 text-search baseline.
- **Patch Guard.** Compare the files and tests an agent reports after editing
  with the graph-backed preflight. Missing primary targets block the patch;
  unexpected scope and missing connected tests are surfaced for review.
- **Persistent runs and activity.** Every browser preflight is saved locally
  with its stage trace, ranking, tests, contract, and MCP/workspace activity.

## Status

The engine, issue-first UI, CLI, and MCP tools are in place. Retrieval is scored
three ways on 114 Django SWE-bench Lite bugs: BM25 only, graph only, and hybrid.
The product keeps BM25 as the safe shortlist, then uses HydraDB to attach callers,
coverage, co-change paths, and tests. Graph evidence only reorders results when a
single candidate is corroborated by a connected covering test; otherwise Lumos
shows the text matches as unverified and will not create an agent handoff.

The frozen earlier ranking experiment tied BM25 at top-3 (74.6%) but trailed at
top-1 (52.6% versus 55.3%). Lumos does not claim to beat text search on every
bug. Its current value is inspectable proof, test impact, and a compact handoff.
The stricter promotion gate should be re-evaluated before publishing a new
top-1 figure.

Measured on Django (`febefb175e`), on a MacBook with an M4 and 16GB of RAM:

| | |
|---|---|
| Extraction | 2,926 files → 43,516 symbols in **8s** |
| Load into HydraDB | 46,444 nodes and 103,968 edges in **17.9s** |
| Impact query, depth 4 | **15–26ms** over 44,304 symbols |

Asking what changing `HttpResponseBase.set_cookie` affects returns
`delete_cookie` and `set_signed_cookie`, then `CookieStorage._update_cookie`
and `SessionMiddleware.process_response` two hops out in different Django
applications, along with the 15 tests that exercise them — each with the call
path that justifies it.

Django is a dataset, not the product. The same `lumos index` / `lumos ask`
path works on any Python repo HydraDB can hold.

Run `pnpm probe` for a self-contained end-to-end check against a live node.

## Quickstart

Requires Docker, Node 20.11+ and pnpm.

```bash
git clone <this-repo> && cd lumos
cp .env.example .env      # then set HOST_UID / HOST_GID to `id -u` and `id -g`
pnpm install

pnpm db:up                # starts HydraDB, blocks until it answers a query
pnpm probe                # end-to-end impact analysis check, prints `probe-ok`

# Load Django, then open the demo
pnpm ingest data/extract/django.jsonl data/extract/django.cochange.jsonl
pnpm api                  # HydraDB-backed API on :8787
pnpm web                  # issue → files / tests / path, on :3000

# Assistant interface
pnpm lumos preflight "Template filter join should not escape the joining string"
pnpm lumos verify "Template filter join should not escape the joining string" \
  --changed django/template/defaultfilters.py \
  --tests template_tests.filter_tests.test_join.FunctionTests.test_autoescape_off
pnpm lumos impact django.http.response.HttpResponseBase.set_cookie
pnpm mcp                  # MCP stdio: preflight_change, verify_patch, impact
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
| `pnpm extract` | Parse a repo into JSONL |
| `pnpm ingest` | Load JSONL into HydraDB |
| `pnpm impact` | Blast radius of a symbol |
| `pnpm retrieve` | Rank files for a bug report |
| `pnpm lumos` | Assistant CLI: `index`, `preflight`, `verify`, `impact`, `tests` |
| `pnpm mcp` | MCP server for Cursor / Claude Code / Codex |
| `pnpm api` | HTTP API for the demo |
| `pnpm web` | Issue-first demo UI |
| `pnpm eval` | SWE-bench Lite: BM25 vs graph vs hybrid |
| `pnpm db:restore` | Reload the Django demo graph after eval |
| `pnpm typecheck` | Typecheck the workspace |

The node listens on `7687` for Bolt, `8443` for the HTTP query API, and `9090`
for `/readyz` and Prometheus metrics.

## Assistant interface

```bash
pnpm lumos index /path/to/repo
pnpm lumos preflight "Changing set_cookie breaks tests"
pnpm lumos verify "Changing set_cookie breaks tests" \
  --changed django/http/response.py \
  --tests responses.test_cookie
pnpm lumos impact django.http.response.HttpResponseBase.set_cookie
pnpm lumos tests django.http.response.HttpResponseBase.set_cookie
```

MCP tools, over stdio (`pnpm mcp`):

- `lumos.preflight_change(issue_text)`
- `lumos.verify_patch(issue_text, changed_files, tests_run)`
- `lumos.find_relevant_files(issue_text)`
- `lumos.explain_file_rank(issue_text, file)`
- `lumos.impact(symbol)`
- `lumos.tests_for_change(symbol)`

Cursor / Claude Code / Codex can call `preflight_change` before editing and
`verify_patch` after editing. Point an MCP client at `pnpm mcp` in this repo.

## Measuring retrieval

```bash
pnpm eval data/swebench/lite.jsonl --repo django/django --root data/repos/django
```

Three columns, 114 Django SWE-bench Lite bugs, gold = the one non-test file the
merged patch actually touched:

| Method | What it is |
|---|---|
| BM25 only | word search |
| Graph only | HydraDB walk from named seeds |
| Hybrid | BM25 seeds names, HydraDB proves impact |

Eval wipes the live graph. Restore the demo afterwards:

```bash
pnpm db:restore
```

## How Lumos uses HydraDB

HydraDB is not a store that Lumos happens to read from — it is where retrieval
happens. Remove it and there is no product left, only a parser.

The central operation is a bounded reverse-reachability closure from the symbols
a question names, returning whole paths so that every retrieved file comes with
the chain that justifies it. That runs inside HydraDB through `algo.MSpaths` with
`relDirection: 'incoming'`, seeded server-side from many symbols at once to avoid
client-side query fan-out.

This is the class of question a vector index cannot answer at all. Similarity is
a scalar between two pieces of text; it has no notion of *calls*, *covers*,
*configures*, or *changes alongside*. Ranking by it cannot express reachability,
and no amount of better chunking adds a traversal.

Two further pieces of HydraDB do real work. Snapshot-consistent reads mean a
retrieval runs against one pinned view of the graph even while ingestion
continues. And GraphBLAS-backed sparse traversal over compiled adjacency is what
keeps a multi-hop closure inside the latency budget of an editor interaction,
which is the whole premise of using a graph for retrieval instead of an index.

`docs/hydradb-constraints.md` records the engine constraints that shaped the data
model, each one verified against a running node rather than taken from
documentation.

## Repository layout

```
infra/              HydraDB + MinIO (docker compose)
scripts/            Lifecycle and readiness scripts
packages/graph/     HydraDB client, traversal
packages/ingest/    JSONL → HydraDB
packages/retrieve/  Mentions, BM25, hybrid ranker, SWE-bench eval
packages/serve/     Demo HTTP API
packages/cli/       `lumos` CLI and MCP server
apps/web/           Issue-first demo UI
docs/               Engine constraints
```

## Attribution

- [HydraDB](https://github.com/hydra-db/hydradb), AGPL-3.0 — the graph database
  Lumos is built on. Lumos communicates with it over its HTTP and Bolt APIs as a
  separate program, and does not link against or vendor its source.
- [SWE-bench](https://github.com/princeton-nlp/SWE-bench) — issue instances and
  gold patches used to evaluate retrieval.

Further datasets and libraries will be credited here as they are integrated.

## License

MIT. See [LICENSE](./LICENSE).
