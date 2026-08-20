/**
 * Rank the files an issue implicates, from the command line.
 *
 *   pnpm retrieve --repo django/django --root data/repos/django --issue-file bug.txt
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { HydraClient } from "@lumos/graph";

import { buildCorpus } from "./corpus.ts";
import { retrieve } from "./retrieve.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    root: { type: "string" },
    issue: { type: "string" },
    "issue-file": { type: "string" },
    limit: { type: "string", default: "15" },
    explain: { type: "boolean", default: false },
  },
});

if (!values.repo || !values.root || !(values.issue || values["issue-file"])) {
  console.error(
    "usage: pnpm retrieve --repo <slug> --root <path> (--issue <text> | --issue-file <path>) [--limit n] [--explain]",
  );
  process.exit(1);
}

const issue = values.issue ?? readFileSync(values["issue-file"]!, "utf8");

const client = new HydraClient();
if (!(await client.ready())) {
  console.error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  process.exit(1);
}

const started = Date.now();
const corpus = buildCorpus(values.root);
const indexed = Date.now();

const result = await retrieve(client, corpus.index, issue, {
  repo: values.repo,
  files: corpus.files,
  testFiles: corpus.testFiles,
  limit: Number(values.limit),
});

const finished = Date.now();

console.log(`\nseeds (${result.seeds.length}):`);
for (const seed of result.seeds.slice(0, 10)) {
  console.log(`  ${seed.weight.toFixed(2)}  ${seed.label.padEnd(6)}  ${seed.via} -> ${seed.path}`);
}

console.log(`\nranked files:`);
result.ranked.forEach((file, position) => {
  const marks = [
    file.lexicalScore > 0 ? `lex ${file.lexicalScore.toFixed(2)}` : "lex —",
    file.graphScore > 0 ? `graph ${file.graphScore.toFixed(2)}` : "graph —",
    file.bm25Rank ? `bm25 #${file.bm25Rank}` : "bm25 miss",
  ].join("  ");
  console.log(`  ${String(position + 1).padStart(2)}. ${file.path}`);
  console.log(`      ${file.score.toFixed(3)}  (${marks})`);
  for (const line of file.why) console.log(`      ${line}`);

  if (values.explain) {
    for (const evidence of file.evidence) {
      const chain = evidence.relTypes.length ? evidence.relTypes.join(" -> ") : "named directly";
      console.log(`      via ${evidence.via}  ${chain}  depth ${evidence.depth}  ${evidence.reached}`);
    }
  }
});

if (result.tests.length > 0) {
  console.log(`\ntests likely to fail:`);
  for (const test of result.tests.slice(0, 12)) {
    console.log(`  ${test.qualname}`);
  }
}

console.log(
  `\n${result.traversal.engine}  ${result.traversal.pathCount} paths  ${result.traversal.elapsedMs}ms walk`,
);
console.log(
  `indexed ${corpus.files.length.toLocaleString()} files in ${indexed - started}ms, ` +
    `retrieved in ${finished - indexed}ms`,
);
