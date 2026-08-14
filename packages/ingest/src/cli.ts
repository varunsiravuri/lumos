/**
 * Load an extracted code graph into HydraDB.
 *
 *   pnpm ingest data/extract/requests.jsonl
 */
import { parseArgs } from "node:util";

import { HydraClient } from "@lumos/graph";

import { IdRegistry } from "./ids.ts";
import { loadExtraction } from "./load.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    registry: { type: "string", default: "data/ids.sqlite" },
    "chunk-size": { type: "string", default: "1000" },
  },
});

if (positionals.length === 0) {
  console.error("usage: pnpm ingest <extraction.jsonl> [cochange.jsonl ...] [--registry path] [--chunk-size n]");
  process.exit(1);
}

const client = new HydraClient();
if (!(await client.ready())) {
  console.error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  process.exit(1);
}

const registry = new IdRegistry(values.registry!);

try {
  const report = await loadExtraction(client, registry, positionals, {
    chunkSize: Number(values["chunk-size"]),
    onProgress: (message) => console.log(`  ${message}`),
  });

  const seconds = report.elapsedMs / 1000;
  const nodes = report.nodes.repos + report.nodes.files + report.nodes.symbols;
  const edges = Object.values(report.edges).reduce((total, count) => total + count, 0);

  console.log(`\n${report.repo}`);
  console.log(`  nodes   ${nodes.toLocaleString()}  (${report.nodes.files.toLocaleString()} files, ${report.nodes.symbols.toLocaleString()} symbols)`);
  console.log(
    `  edges   ${edges.toLocaleString()}  (${report.edges.calls.toLocaleString()} calls, ` +
      `${report.edges.defines.toLocaleString()} defines, ${report.edges.imports.toLocaleString()} imports, ` +
      `${report.edges.covers.toLocaleString()} covers, ${report.edges.cochanges.toLocaleString()} co-changes)`,
  );
  if (report.danglingEdges > 0) {
    console.log(`  dropped ${report.danglingEdges.toLocaleString()} edges with unresolved endpoints`);
  }
  console.log(`  time    ${seconds.toFixed(1)}s`);
  console.log(`  rate    ${Math.round(report.nodesPerSecond).toLocaleString()} nodes/s, ${Math.round(report.edgesPerSecond).toLocaleString()} edges/s`);
  console.log(`\nextractor: ${JSON.stringify(report.extractorStats)}`);
} finally {
  registry.close();
}
