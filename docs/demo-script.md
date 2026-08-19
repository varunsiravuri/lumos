# 90-second demo

Lumos is the retrieval engine an IDE assistant calls before it edits.
Word search guesses. Lumos traces impact.

## Setup

```bash
pnpm db:up
pnpm db:restore          # Django graph at febefb175e
pnpm api                 # :8787
pnpm web                 # :3000
```

## Script

**0:00 — The claim**

Every IDE assistant retrieves by similar words. Track 02B says that is a weak
proxy: assistants need call chains, type definitions, startup configs, and tests.

Lumos is not a Django graph browser. Paste a bug, get the files to edit, the
path that proves it, and the tests that go red.

**0:20 — Killer issue (`django__django-16873`)**

Click **SWE-bench demo**.

Bug: template filter `join` still escapes the joining string when `autoescape`
is off. The merged patch touches `django/template/defaultfilters.py`.

**0:35 — Two columns disagree**

Word search ranks `defaultfilters.py` **third**. It likes `defaulttags.py`
because the issue also says `autoescape`.

Lumos ranks `defaultfilters.py` **first**:

```
bug text
  → quoted seed `join`
  → django.template.defaultfilters.join
  → CALLS / COVERS walk in HydraDB (tens of ms)
  → tests: template_tests.filter_tests.test_join.FunctionTests.test_autoescape_off
  → target file: django/template/defaultfilters.py
```

The gold file is marked **patch**.

**0:55 — Graph evidence panel**

Read the left rail out loud:

- engine: HydraDB `algo.MSpaths`
- direction: both, CALLS + COVERS
- seeds, path count, latency

Then: without HydraDB there is no reverse call chain, no test impact, no
transitive blast radius — only lexical similarity.

**1:10 — Assistant interface**

```bash
pnpm lumos ask "Template filter join should not escape the joining string"
# or: pnpm mcp
```

Cursor, Claude Code, Codex call `lumos.find_relevant_files` before they edit.

**1:25 — The score**

Footer: 114 real Django bugs. BM25 vs graph vs hybrid.

Pure graph retrieval loses. Hybrid graph retrieval wins.
BM25 finds likely names. HydraDB proves impact.

**1:40 — Optional symbol walk**

`set_cookie` → incoming CALLS → `SessionMiddleware.process_response`,
15 tests, ~15ms. The map is evidence, not the product.
