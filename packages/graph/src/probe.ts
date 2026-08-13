/**
 * End-to-end check that Lumos can talk to HydraDB and that the one query the
 * product depends on — reverse reachability over the call graph — actually works.
 *
 * Builds a throwaway call graph, asks what would be affected by changing a
 * single function, asserts the result, and removes what it created.
 *
 *   pnpm probe
 */
import assert from "node:assert/strict";

import { HydraClient } from "./client.ts";
import { closure, reachedNodes } from "./traverse.ts";

// Ingested ids are allocated sequentially from 1, so the probe sits far above
// anything a real repository will reach.
const BASE = 9_000_000_000_000;
const ID = {
  appEntry: BASE + 1,
  refreshSession: BASE + 2,
  handleRequest: BASE + 3,
  validateToken: BASE + 4,
};

const SYMBOLS = [
  { vertex: ID.appEntry, name: "app_entry", file: "app/main.py" },
  { vertex: ID.refreshSession, name: "refresh_session", file: "app/session.py" },
  { vertex: ID.handleRequest, name: "handle_request", file: "app/server.py" },
  { vertex: ID.validateToken, name: "validate_token", file: "app/auth.py" },
];

// app_entry -> handle_request -> validate_token, and refresh_session calls it too.
const CALLS = [
  { src: ID.appEntry, dst: ID.handleRequest, rel: BASE + 101, line: 42 },
  { src: ID.handleRequest, dst: ID.validateToken, rel: BASE + 102, line: 88 },
  { src: ID.refreshSession, dst: ID.validateToken, rel: BASE + 103, line: 17 },
];

async function main(): Promise<void> {
  const client = new HydraClient();

  if (!(await client.ready())) {
    throw new Error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  }
  console.log(`connected to ${client.config.httpUrl}`);

  await cleanup(client);

  await client.upsertNodes("ProbeSymbol", SYMBOLS);
  await client.createEdges("PROBE_CALLS", "ProbeSymbol", "ProbeSymbol", CALLS);
  console.log(`wrote ${SYMBOLS.length} symbols and ${CALLS.length} call edges`);

  // "What is affected if I change validate_token?" is a closure seeded at the
  // symbol, walking call edges backwards to every transitive caller.
  const started = performance.now();
  const paths = await closure(client, {
    label: "ProbeSymbol",
    property: "name",
    values: ["validate_token"],
    relTypes: ["PROBE_CALLS"],
    direction: "incoming",
    maxLen: 5,
  });
  const elapsedMs = performance.now() - started;

  const affected = reachedNodes(paths);
  const names = affected.map((node) => String(node.properties.name)).sort();

  console.log(`impact resolved in ${elapsedMs.toFixed(1)}ms`);
  for (const node of affected) {
    console.log(`  depth ${node.depth}  ${String(node.properties.name)}  (${String(node.properties.file)})`);
  }

  assert.deepEqual(names, ["app_entry", "handle_request", "refresh_session", "validate_token"]);

  await cleanup(client);
  console.log("probe-ok");
}

async function cleanup(client: HydraClient): Promise<void> {
  await client.query("UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n", {
    parameters: { rows: SYMBOLS.map(({ vertex }) => ({ vertex })) },
  });
}

await main();
