import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Documentation | Lumos",
  description: "Install Lumos, index a Python repository, connect an IDE agent through MCP, and inspect HydraDB proof paths.",
};

const docsNavigation = [
  {
    title: "Start",
    links: [
      ["Overview", "#overview"],
      ["Quick start", "#quick-start"],
    ],
  },
  {
    title: "Use Lumos",
    links: [
      ["Index a repository", "#index-repository"],
      ["Preflight a change", "#ask-lumos"],
      ["Verify a patch", "#verify-patch"],
      ["Inspect impact", "#inspect-impact"],
    ],
  },
  {
    title: "Connect agents",
    links: [
      ["MCP setup", "#mcp-setup"],
      ["Available tools", "#mcp-tools"],
    ],
  },
  {
    title: "Understand results",
    links: [
      ["Proof paths", "#proof-paths"],
      ["Evaluation", "#evaluation"],
      ["Troubleshooting", "#troubleshooting"],
    ],
  },
] as const;

const mcpTools = [
  ["lumos.preflight_change", "Run before editing. Return ranked files, graph proof, connected tests, a context contract, and its digest."],
  ["lumos.verify_patch", "Run after editing. Check the changed files and reported tests against a fresh graph-backed preflight."],
  ["lumos.find_relevant_files", "Turn an issue into ranked files, reasons, graph evidence, and likely tests."],
  ["lumos.explain_file_rank", "Explain why one file appears at its position for a specific issue."],
  ["lumos.impact", "Walk callers, callees, and coverage around a named symbol."],
  ["lumos.tests_for_change", "Find tests connected to a symbol through the HydraDB graph."],
] as const;

export default function DocsPage() {
  return (
    <main className="docs-page min-h-[100dvh]">
      <a className="docs-skip-link" href="#docs-content">Skip to documentation</a>

      <header className="docs-site-header">
        <div className="docs-site-header-inner">
          <Link href="/" className="docs-wordmark" aria-label="Lumos home">LUMOS</Link>
          <nav aria-label="Documentation navigation" className="docs-top-nav">
            <Link href="/docs" aria-current="page" className="docs-top-link">Docs</Link>
            <Link href="/app" className="docs-open-link">Open Lumos</Link>
          </nav>
        </div>
      </header>

      <section className="docs-hero">
        <div className="docs-hero-inner">
          <div className="docs-hero-copy">
            <p className="docs-kicker">Documentation</p>
            <h1>Context your agent can inspect.</h1>
            <p>
              Preflight an agent change, return ranked context with a HydraDB proof path, then verify the patch stayed inside it.
            </p>
          </div>

          <div className="docs-fast-path" aria-label="Quick start commands">
            <div className="docs-code-heading">
              <span>Fast path</span>
              <span>Local setup</span>
            </div>
            <pre><code>{`pnpm install
pnpm db:up
pnpm probe

pnpm lumos index /path/to/repo
pnpm lumos preflight "Describe the change"`}</code></pre>
          </div>
        </div>
      </section>

      <div id="docs-content" className="docs-layout">
        <aside className="docs-sidebar">
          <nav aria-label="Documentation sections">
            {docsNavigation.map((group) => (
              <div className="docs-nav-group" key={group.title}>
                <p>{group.title}</p>
                {group.links.map(([label, href]) => (
                  <a href={href} key={href}>{label}</a>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <article className="docs-article">
          <section id="overview" className="docs-section docs-section-lead">
            <h2>Lumos in one minute</h2>
            <p className="docs-lede">
              Lumos is the preflight and verification layer an IDE assistant calls around an edit. Word search finds likely names. HydraDB proves structural impact. Patch Guard checks what the agent actually changed.
            </p>
            <dl className="docs-return-map">
              <div>
                <dt>Ranked context</dt>
                <dd>The smallest set of files likely to matter for the requested change.</dd>
              </div>
              <div>
                <dt>Graph proof</dt>
                <dd>The calls and coverage relationships behind each recommendation.</dd>
              </div>
              <div>
                <dt>Test impact</dt>
                <dd>The checks connected to the symbols an agent is about to touch.</dd>
              </div>
              <div>
                <dt>Patch Guard</dt>
                <dd>A post-edit verdict on target coverage, unexpected scope, and connected tests.</dd>
              </div>
            </dl>
          </section>

          <section id="quick-start" className="docs-section">
            <h2>Quick start</h2>
            <p>Run Lumos locally with Node 20.11 or newer, pnpm, and Docker.</p>

            <div className="docs-instruction">
              <h3>Install</h3>
              <pre><code>{`git clone <this-repo>
cd lumos
cp .env.example .env
pnpm install`}</code></pre>
              <p>Set <code>HOST_UID</code> and <code>HOST_GID</code> in <code>.env</code> to the output of <code>id -u</code> and <code>id -g</code>.</p>
            </div>

            <div className="docs-instruction">
              <h3>Start HydraDB</h3>
              <pre><code>{`pnpm db:up
pnpm probe`}</code></pre>
              <p><code>db:up</code> waits for a real query to succeed. <code>probe</code> verifies the full write and traversal path.</p>
            </div>

            <div className="docs-note">
              <strong>Expected signal</strong>
              <p>The setup is ready when the terminal prints <code>hydradb-ok</code> and <code>probe-ok</code>.</p>
            </div>
          </section>

          <section id="index-repository" className="docs-section">
            <h2>Index a repository</h2>
            <p>Lumos currently extracts Python repositories. Give the indexer a local checkout and an optional stable slug.</p>
            <pre><code>{`pnpm lumos index /path/to/repo --slug owner/name`}</code></pre>
            <p>The indexer extracts files, symbols, definitions, imports, calls, test coverage, and co-change relationships before loading them into HydraDB.</p>
          </section>

          <section id="ask-lumos" className="docs-section">
            <h2>Preflight a change</h2>
            <p>Describe the task as you would describe it to a coding agent. A bug report, issue, or stack trace all work.</p>
            <pre><code>{`pnpm lumos preflight "Changing set_cookie breaks signed cookie tests"`}</code></pre>
            <div className="docs-result-shape">
              <div>
                <span>Targets</span>
                <p>Files and symbols ordered by relevance.</p>
              </div>
              <div>
                <span>Reasons</span>
                <p>Why each target belongs in the context.</p>
              </div>
              <div>
                <span>Evidence</span>
                <p>The HydraDB relationship path.</p>
              </div>
              <div>
                <span>Tests</span>
                <p>Checks likely to protect the change.</p>
              </div>
            </div>
          </section>

          <section id="verify-patch" className="docs-section">
            <h2>Verify the agent&apos;s patch</h2>
            <p>After the edit, report the repository-relative files that changed and the tests the agent ran.</p>
            <pre><code>{`pnpm lumos verify "Changing set_cookie breaks signed cookie tests" \\
  --changed django/http/response.py \\
  --tests responses.test_cookie`}</code></pre>
            <p>Patch Guard blocks a missing primary target and asks for review when the patch leaves the preflight shortlist or omits a connected test. It does not claim to execute the tests or inspect the diff contents.</p>
          </section>

          <section id="inspect-impact" className="docs-section">
            <h2>Inspect impact directly</h2>
            <p>Use a qualified symbol when you already know the center of the change.</p>
            <pre><code>{`pnpm lumos impact django.http.response.HttpResponseBase.set_cookie
pnpm lumos tests django.http.response.HttpResponseBase.set_cookie`}</code></pre>
            <p>The impact command walks the blast radius. The tests command narrows the result to connected coverage.</p>
          </section>

          <section id="mcp-setup" className="docs-section">
            <h2>Connect an IDE agent with MCP</h2>
            <p>Run the stdio server from the repository and point your MCP client at the same command.</p>
            <pre><code>{`{
  "mcpServers": {
    "lumos": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/absolute/path/to/lumos"
    }
  }
}`}</code></pre>
            <p>Cursor, Claude Code, Codex, and other MCP clients can call <code>lumos.preflight_change</code> before an edit and <code>lumos.verify_patch</code> after it.</p>
          </section>

          <section id="mcp-tools" className="docs-section">
            <h2>Available MCP tools</h2>
            <div className="docs-tool-list">
              {mcpTools.map(([name, description]) => (
                <div key={name}>
                  <code>{name}</code>
                  <p>{description}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="proof-paths" className="docs-section">
            <h2>How proof paths work</h2>
            <p>
              Lumos starts with names found in the issue, resolves them to symbols, and asks HydraDB for bounded relationship paths. The full path stays attached to the ranked result.
            </p>
            <ol className="docs-proof-flow">
              <li><strong>Resolve intent</strong><span>Extract named behavior from the request.</span></li>
              <li><strong>Seed the graph</strong><span>Match that behavior to repository symbols.</span></li>
              <li><strong>Walk impact</strong><span>Traverse calls and coverage with <code>algo.MSpaths</code>.</span></li>
              <li><strong>Return evidence</strong><span>Rank the context and keep the relationship chain.</span></li>
            </ol>
          </section>

          <section id="evaluation" className="docs-section">
            <h2>Evaluate retrieval</h2>
            <p>Compare word search, graph-only retrieval, and the hybrid ranker against SWE-bench Lite gold files.</p>
            <pre><code>{`pnpm eval data/swebench/lite.jsonl --repo django/django --root data/repos/django

pnpm db:restore`}</code></pre>
            <div className="docs-evaluation-note">
              <strong>Read the comparison honestly.</strong>
              <p>BM25 finds names. The graph matters when repository structure provides evidence that text similarity cannot express.</p>
            </div>
          </section>

          <section id="troubleshooting" className="docs-section">
            <h2>Troubleshooting</h2>
            <div className="docs-disclosures">
              <details>
                <summary>HydraDB is not ready</summary>
                <p>Run <code>pnpm db:up</code>, wait for <code>hydradb-ok</code>, then verify the connection with <code>pnpm probe</code>.</p>
              </details>
              <details>
                <summary>The demo graph disappeared after evaluation</summary>
                <p>The evaluation run resets the live graph. Restore the Django snapshot with <code>pnpm db:restore</code>.</p>
              </details>
              <details>
                <summary>The web interface has no live results</summary>
                <p>Start the HydraDB-backed API with <code>pnpm api</code>, then run the site with <code>pnpm web</code>.</p>
              </details>
            </div>
          </section>
        </article>

        <aside className="docs-outline" aria-label="On this page">
          <p>On this page</p>
          <a href="#quick-start">Quick start</a>
          <a href="#index-repository">Index a repository</a>
          <a href="#ask-lumos">Ask Lumos</a>
          <a href="#verify-patch">Verify a patch</a>
          <a href="#mcp-setup">MCP setup</a>
          <a href="#proof-paths">Proof paths</a>
          <a href="#evaluation">Evaluation</a>
        </aside>
      </div>

      <footer className="docs-footer">
        <span className="docs-wordmark">LUMOS</span>
        <p>Graph-native context for coding agents.</p>
      </footer>
    </main>
  );
}
