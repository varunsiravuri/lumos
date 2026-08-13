/**
 * End-to-end check that Lumos can talk to HydraDB and that the one query the
 * product depends on — reverse-dependency closure — actually works.
 *
 * Builds a throwaway dependency graph, computes the blast radius of a
 * compromised package, asserts the result, and removes what it created.
 *
 *   pnpm probe
 */
import assert from "node:assert/strict";

import { HydraClient } from "./client.ts";
import { closure, reachedNodes } from "./traverse.ts";

// A reserved id range keeps the probe from colliding with ingested data.
const BASE = 900_000;
const ID = {
  appCheckout: BASE + 1,
  appBilling: BASE + 2,
  uiKit: BASE + 3,
  colorName: BASE + 4,
};

const PACKAGES = [
  { vertex: ID.appCheckout, name: "app-checkout" },
  { vertex: ID.appBilling, name: "app-billing" },
  { vertex: ID.uiKit, name: "ui-kit" },
  { vertex: ID.colorName, name: "color-name" },
];

// app-checkout -> ui-kit -> color-name, and app-billing -> color-name directly.
const DEPENDENCIES = [
  { src: ID.appCheckout, dst: ID.uiKit, rel: BASE + 101, range: "^2.0.0" },
  { src: ID.uiKit, dst: ID.colorName, rel: BASE + 102, range: "^1.1.0" },
  { src: ID.appBilling, dst: ID.colorName, rel: BASE + 103, range: "^1.1.0" },
];

async function main(): Promise<void> {
  const client = new HydraClient();

  if (!(await client.ready())) {
    throw new Error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  }
  console.log(`connected to ${client.config.httpUrl}`);

  await cleanup(client);

  await client.upsertNodes("ProbePackage", PACKAGES);
  await client.createEdges("PROBE_DEPENDS_ON", "ProbePackage", "ProbePackage", DEPENDENCIES);
  console.log(`wrote ${PACKAGES.length} packages and ${DEPENDENCIES.length} dependency edges`);

  const started = performance.now();
  const paths = await closure(client, {
    label: "ProbePackage",
    property: "name",
    values: ["color-name"],
    relTypes: ["PROBE_DEPENDS_ON"],
    direction: "incoming",
    maxLen: 5,
  });
  const elapsedMs = performance.now() - started;

  const reached = reachedNodes(paths);
  const names = reached.map((node) => String(node.properties.name)).sort();

  console.log(`blast radius resolved in ${elapsedMs.toFixed(1)}ms`);
  for (const node of reached) {
    console.log(`  depth ${node.depth}  ${String(node.properties.name)}`);
  }

  assert.deepEqual(names, ["app-billing", "app-checkout", "color-name", "ui-kit"]);

  await cleanup(client);
  console.log("probe-ok");
}

async function cleanup(client: HydraClient): Promise<void> {
  await client.query("UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n", {
    parameters: { rows: PACKAGES.map(({ vertex }) => ({ vertex })) },
  });
}

await main();
