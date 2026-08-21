# Lumos

Preflight and verification for coding agents.

Before an agent edits your repo, Lumos finds the files and tests that matter and
shows why. After the edit, Patch Guard checks that the change stayed on target.

> Word search finds likely names. Lumos proves impact with a code graph (HydraDB).

Live demo: [lumos.uno](https://lumos.uno)

## Why it exists

Most assistants search by similar words. That often returns code that *sounds*
like the bug, not the code a fix actually depends on.

Lumos indexes the repo as a graph (calls, coverage, co-change), then:

1. **Preflight** — given one issue, return ranked files, graph evidence, and tests
2. **Handoff** — give the agent a small, inspectable context package
3. **Verify** — after the edit, check changed files and tests against that plan

Django is the included demo dataset, not the product. Index any supported
Python or TypeScript repo the same way.

## Quickstart

Needs Docker, Node 20.11+, and pnpm.

```bash
git clone <this-repo> && cd lumos
cp .env.example .env
# Set HOST_UID / HOST_GID to the output of `id -u` and `id -g`
pnpm install

pnpm db:up                 # start HydraDB (waits until it answers a query)
pnpm probe                 # should print probe-ok

# Load the Django demo graph, then open the UI
pnpm ingest data/extract/django.jsonl data/extract/django.cochange.jsonl
pnpm api                   # API on :8787
pnpm web                   # UI on :3000
```

Open [http://localhost:3000](http://localhost:3000), then **Try Lumos on Django**.

### Use it from an agent

```bash
pnpm lumos index /path/to/repo
pnpm lumos preflight "Template filter join should not escape the joining string"
pnpm lumos verify "Template filter join should not escape the joining string" \
  --changed django/template/defaultfilters.py \
  --tests template_tests.filter_tests.test_join.FunctionTests.test_autoescape_off

pnpm mcp                   # MCP stdio for Cursor / Claude Code / Codex
```

Main MCP tools:

- `lumos.preflight_change` — files, evidence, and tests before editing
- `lumos.verify_patch` — check the edit against that plan
- `lumos.explain_file_rank` / `lumos.impact` — inspect why a file or symbol ranked

## Useful commands

| Command | What it does |
|---|---|
| `pnpm db:up` / `db:down` | Start or stop HydraDB |
| `pnpm db:restore` | Reload the Django demo graph |
| `pnpm probe` | End-to-end health check |
| `pnpm api` / `pnpm web` | Demo API + UI |
| `pnpm lumos` | CLI (`index`, `preflight`, `verify`, `impact`, …) |
| `pnpm mcp` | MCP server |
| `pnpm eval` | SWE-bench Lite: BM25 vs graph vs hybrid |
| `pnpm typecheck` / `pnpm test` | Typecheck and unit tests |

HydraDB ports (local): Bolt `7687`, HTTP `8443`, admin `9090`.

## How retrieval works (short version)

1. Text for likely file/symbol names (BM25)
2. Walk the HydraDB graph for callers, coverage, and related impact
3. Rank files with inspectable paths; attach connected tests
4. Only promote graph-backed results when evidence is strong enough for handoff

Eval on 114 Django SWE-bench Lite bugs compares BM25, graph-only, and hybrid.
Eval wipes the live graph — restore with `pnpm db:restore` afterward.

```bash
pnpm eval data/swebench/lite.jsonl --repo django/django --root data/repos/django
pnpm db:restore
```

Engine details and HydraDB limits: [docs/hydradb-constraints.md](./docs/hydradb-constraints.md).
Demo walkthrough: [docs/demo-script.md](./docs/demo-script.md).

## Repo layout

```
infra/              HydraDB + MinIO
packages/graph/     HydraDB client + traversal
packages/ingest/    Load extract JSONL into the graph
packages/retrieve/  Ranking, impact, eval
packages/serve/     HTTP API
packages/cli/       lumos CLI + MCP
apps/web/           Demo UI
docs/               Constraints + demo notes
```

## Attribution

- [HydraDB](https://github.com/hydra-db/hydradb) (AGPL-3.0) — graph database Lumos talks to over HTTP/Bolt
- [SWE-bench](https://github.com/princeton-nlp/SWE-bench) — issues and gold patches used for eval

## License

MIT. See [LICENSE](./LICENSE).
