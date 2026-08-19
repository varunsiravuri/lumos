import Link from "next/link";
import { CinematicHero } from "@/components/cinematic-hero";

const proofNodes = [
  ["Request intent", "Preserve trusted output", "request"],
  ["Relevant behavior", "Template joining", "symbol"],
  ["Change area", "Escaping boundary", "target"],
  ["Safety signal", "Rendered output", "test"],
  ["Agent brief", "Ready to edit", "handoff"],
] as const;

const repositoryNodes = [
  ["Input intent", "intent"],
  ["Shared behavior", "shared"],
  ["Render path", "render"],
  ["Safety coverage", "coverage"],
  ["Change history", "history"],
  ["Call surface", "call"],
  ["Scope boundary", "scope"],
  ["Related behavior", "related"],
] as const;

const workflow = [
  ["Resolve", "Turn the issue into concrete files and symbols."],
  ["Trace", "Walk the HydraDB graph through code relationships."],
  ["Prove", "Attach inspectable evidence and relevant tests."],
  ["Handoff", "Send a compact context package to the coding agent."],
] as const;

export default function Home() {
  return (
    <main className="marketing-home min-h-[100dvh] overflow-x-clip bg-[#f4f9fd] text-[#0a1b33]">
      <CinematicHero />

      <section id="product" className="product-sky relative overflow-hidden px-5 pb-28 pt-24 sm:px-8 sm:pb-36 sm:pt-32 lg:px-12">
        <div className="relative mx-auto max-w-[1440px]">
          <div className="product-intro mx-auto max-w-[1040px] text-center">
            <p className="section-kicker">Graph-native context</p>
            <h2 className="mt-5 text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-6xl lg:text-7xl">
              One request becomes a complete trail to the code that matters.
            </h2>
            <p className="mx-auto mt-7 max-w-[680px] text-lg leading-8 text-[#49637e]">
              Lumos follows real repository relationships, then returns only the files, tests, and evidence a coding agent needs.
            </p>
          </div>

          <figure className="proof-constellation mt-20 sm:mt-24" aria-labelledby="proof-constellation-title">
            <div className="proof-constellation-copy">
              <figcaption id="proof-constellation-title">Live repository graph</figcaption>
              <h3>See the evidence assemble around one request.</h3>
              <p>
                Lumos starts with the issue, follows HydraDB relationships, and lights up the smallest defensible path to the edit.
              </p>

              <dl className="graph-readout">
                <div>
                  <dt>Relationship trail</dt>
                  <dd>Definition + coverage</dd>
                </div>
                <div>
                  <dt>Focused context</dt>
                  <dd>12 signals</dd>
                </div>
                <div>
                  <dt>Safety coverage</dt>
                  <dd>20 checks</dd>
                </div>
              </dl>

              <div className="graph-legend" aria-label="Graph legend">
                <span><i className="graph-legend-route" />Selected evidence chain</span>
                <span><i className="graph-legend-context" />Surrounding context</span>
              </div>
            </div>

            <div className="proof-graph-shell">
              <div className="proof-graph-toolbar">
                <span>Evidence map</span>
                <span className="proof-graph-live"><i />Connected</span>
              </div>

              <div
                className="proof-graph-canvas"
                role="img"
                aria-label="A light knowledge graph connecting request intent, relevant behavior, the change area, a safety signal, and an agent brief"
              >
                <svg className="proof-graph-edges" viewBox="0 0 820 560" preserveAspectRatio="none" aria-hidden="true">
                  <path className="graph-edge graph-edge-route" d="M98 302 C180 300 198 175 279 168 C356 162 373 291 459 291 C548 291 555 160 640 162 C706 164 696 350 722 403" />
                  <path className="graph-edge graph-edge-context" d="M58 100 C112 158 118 231 98 302" />
                  <path className="graph-edge graph-edge-context" d="M180 459 C265 429 371 339 459 291" />
                  <path className="graph-edge graph-edge-context" d="M426 67 C426 136 444 217 459 291" />
                  <path className="graph-edge graph-edge-context" d="M377 482 C490 465 584 317 640 162" />
                  <path className="graph-edge graph-edge-context" d="M762 196 C720 188 683 171 640 162" />
                  <path className="graph-edge graph-edge-context" d="M694 484 C706 454 716 426 722 403" />
                  <path className="graph-edge graph-edge-context" d="M296 80 C294 112 288 141 279 168" />
                  <path className="graph-edge graph-edge-context" d="M563 430 C512 398 483 352 459 291" />
                  <path className="graph-edge graph-edge-context" d="M563 430 C620 430 680 421 722 403" />
                  <path className="graph-edge graph-edge-context" d="M180 459 C247 480 311 491 377 482" />
                </svg>

                <ol className="proof-node-list">
                  {proofNodes.map(([title, body, position]) => (
                    <li key={title} className={`proof-node proof-node-${position}`}>
                      <i className="proof-node-orb" aria-hidden="true" />
                      <span className="proof-node-copy">
                        <span className="proof-node-title">{title}</span>
                        <strong>{body}</strong>
                      </span>
                    </li>
                  ))}
                </ol>

                <ul className="repository-node-list" aria-label="Related repository nodes">
                  {repositoryNodes.map(([label, position]) => (
                    <li key={label} className={`repository-node repository-node-${position}`}>
                      <span aria-hidden="true" />
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </figure>
        </div>
      </section>

      <section id="workflow" className="px-5 pb-28 sm:px-8 sm:pb-36 lg:px-12">
        <div className="workflow-constellation mx-auto max-w-[1440px] overflow-hidden">
          <div className="workflow-constellation-copy">
            <div>
              <p className="section-kicker">The evidence route</p>
              <h2 className="max-w-md text-4xl font-semibold leading-[1.06] tracking-[-0.04em] text-[#09203e] sm:text-5xl">
                From request to ready-to-edit context.
              </h2>
            </div>
            <p className="max-w-md text-base leading-7 text-[#526b84]">
                Four graph-native actions turn an issue into a handoff an agent can inspect and use.
            </p>
          </div>

          <div className="workflow-orbit">
            <svg className="workflow-orbit-line" viewBox="0 0 1200 360" preserveAspectRatio="none" aria-hidden="true">
              <path d="M120 206 C252 206 285 82 425 82 C560 82 592 225 730 225 C874 225 900 103 1062 103" />
            </svg>
            <ol className="workflow-orbit-list">
              {workflow.map(([title, body], index) => (
                <li key={title} className={`workflow-orbit-step workflow-orbit-step-${index + 1}`}>
                  <span className="workflow-orbit-marker">0{index + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section id="proof" className="proof-sky relative overflow-hidden px-5 py-28 sm:px-8 sm:py-36 lg:px-12">
        <div className="mx-auto grid max-w-[1440px] items-center gap-14 lg:grid-cols-[0.78fr_1.22fr] lg:gap-24">
          <div>
            <p className="section-kicker">Counterfactual proof</p>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.045em] sm:text-5xl lg:text-6xl">
              See exactly what the graph changed.
            </h2>
            <p className="mt-7 max-w-[570px] text-lg leading-8 text-[#47627d]">
              Word search ranked the change area third. HydraDB connected the intended behavior to its safety signal and promoted the right context to first.
            </p>

            <dl className="counterfactual-stats mt-10 grid max-w-xl grid-cols-3 gap-5">
              <div>
                <dt>Word search</dt>
                <dd>#3</dd>
              </div>
              <div>
                <dt>Lumos</dt>
                <dd>#1</dd>
              </div>
              <div>
                <dt>Graph walk</dt>
                <dd>6 ms</dd>
              </div>
            </dl>
          </div>

          <figure className="proof-ledger" aria-labelledby="proof-ledger-title">
            <figcaption id="proof-ledger-title" className="proof-ledger-heading">
              Why HydraDB changed the answer
            </figcaption>
            <div className="proof-rank-shift">
              <div>
                <span>Lexical baseline</span>
                <strong>#3</strong>
                <p>Names match several nearby files.</p>
              </div>
              <div className="proof-rank-change" aria-hidden="true">to</div>
              <div>
                <span>Evidence-backed rank</span>
                <strong>#1</strong>
                <p>The graph connects the symbol to its covering test.</p>
              </div>
            </div>
            <ol className="proof-path">
              <li><span>Named behavior</span><strong>Template joining</strong></li>
              <li><span>Change surface</span><strong>Output escaping boundary</strong></li>
              <li><span>Safety signal</span><strong>Rendered output contract</strong></li>
            </ol>
            <p className="proof-verdict">
              Without HydraDB, there is no reverse call chain and no test-impact path to justify the promotion.
            </p>
          </figure>
        </div>
      </section>

      <section className="landing-closing px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <div className="landing-closing-inner mx-auto max-w-[1440px]">
          <p className="landing-closing-statement">
            The best context is not the largest. It is the smallest set of evidence an agent can trust.
          </p>
          <div className="landing-closing-detail">
            <p>Lumos turns repository structure into a clear starting point for every change.</p>
            <Link href="/docs">Explore the documentation</Link>
          </div>
        </div>
      </section>

      <footer className="px-5 pb-8 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-4 border-t border-[#bdd4e7] pt-7 text-sm text-[#587089] sm:flex-row sm:items-center sm:justify-between">
          <span className="footer-wordmark">LUMOS</span>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="footer-link">Docs</Link>
            <p>Graph-native context for coding agents.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
