import assert from "node:assert/strict";
import test from "node:test";

import { explicitQuotedIdentifiers } from "./mentions.ts";
import { hasExplicitPromotionSeed } from "./retrieve.ts";

test("promotion requires a symbol explicitly marked as code", () => {
  const issue = "Template filter `join` should respect `autoescape`.";
  assert.deepEqual([...explicitQuotedIdentifiers(issue)], ["join", "autoescape"]);
  assert.equal(hasExplicitPromotionSeed(issue, ["join"]), true);
  assert.equal(hasExplicitPromotionSeed(issue, ["escape"]), false);
});

test("prose and fenced examples cannot reorder BM25 by themselves", () => {
  const issue = "Subquery.as_sql() fails.\n```python\nSubquery(query).as_sql()\n```";
  assert.equal(hasExplicitPromotionSeed(issue, ["Subquery.as_sql", "as_sql"]), false);
});
