/**
 * Print the blast radius of a symbol.
 *
 *   pnpm impact --repo django/django --symbol django.http.response.HttpResponseBase.set_cookie
 */
import { parseArgs } from "node:util";

import { HydraClient } from "@lumos/graph";

import { impact } from "./impact.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    symbol: { type: "string" },
    hops: { type: "string", default: "4" },
  },
});

if (!values.repo || !values.symbol) {
  console.error("usage: pnpm impact --repo <slug> --symbol <qualname or name> [--hops n]");
  process.exit(1);
}

const client = new HydraClient();
if (!(await client.ready())) {
  console.error(`HydraDB is not ready at ${client.config.adminUrl}. Run: pnpm db:up`);
  process.exit(1);
}

const result = await impact(client, {
  repo: values.repo,
  symbol: values.symbol,
  maxHops: Number(values.hops),
});

if (!result) {
  console.error(`no symbol matching ${JSON.stringify(values.symbol)} in ${values.repo}`);
  process.exit(2);
}

console.log(`\n${result.seed.qualname}`);
console.log(`  ${result.seed.path}  (${result.seed.kind})`);
console.log(`  ${result.symbols.length} symbols  ${result.tests.length} tests  ${result.elapsedMs}ms\n`);

for (const hit of result.symbols.slice(0, 40)) {
  console.log(`  d${hit.depth}  ${hit.qualname}`);
  console.log(`       ${hit.path}`);
}

if (result.tests.length > 0) {
  console.log(`\ntests (${result.tests.length}):`);
  for (const hit of result.tests.slice(0, 20)) {
    console.log(`  d${hit.depth}  ${hit.qualname}`);
  }
}
