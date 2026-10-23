import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedDemo } from "../src/sql/seed.ts";
import { introspect } from "../src/sql/introspect.ts";
import { applyGuardrails, explainGuard } from "../src/sql/guardrails.ts";
import { extractSQL } from "../src/sql/generate.ts";
import { askSql } from "../src/sql/index.ts";
import { parseOllamaLine } from "../src/providers.ts";
import { resultsEqual, attribute } from "../src/sql/eval/eval.ts";
import { MockEmbedder } from "../src/embed.ts";
import type { ChatProvider } from "../src/providers.ts";
import type { Message, ToolSpec } from "../src/types.ts";

function demoDb() {
  const db = new DatabaseSync(":memory:");
  seedDemo(db);
  return db;
}

test("guardrail: DROP TABLE is rejected (read-only + forbidden keyword)", () => {
  const schema = introspect(demoDb());
  const g = applyGuardrails("DROP TABLE customers", schema);
  assert.ok(g.violations.some((v) => /read-only/i.test(v)));
  assert.ok(g.violations.some((v) => /forbidden keyword/i.test(v)));
});

test("guardrail: hallucinated table is rejected", () => {
  const schema = introspect(demoDb());
  const g = applyGuardrails("SELECT * FROM nonexistent_table", schema);
  assert.ok(g.violations.some((v) => /unknown table/i.test(v)));
});

test("guardrail: LIMIT injected when absent, kept when present", () => {
  const schema = introspect(demoDb());
  const g = applyGuardrails("SELECT id FROM customers", schema);
  assert.match(g.sql, /LIMIT 1000$/);
  const g2 = applyGuardrails("SELECT id FROM customers LIMIT 5", schema);
  assert.equal(g2.sql, "SELECT id FROM customers LIMIT 5");
});

test("semicolons inside string literals survive extraction and read-only check", () => {
  // Literal containing a semicolon must not truncate the SQL…
  const sql = extractSQL("SELECT reason FROM returns WHERE reason = 'a;b' AND id = 1");
  assert.ok(sql.endsWith("id = 1"), `truncated: ${sql}`);
  // …and must not be treated as a second (non-read-only) statement.
  const schema = introspect(demoDb());
  const g = applyGuardrails(sql, schema);
  assert.deepEqual(g.violations, []);
});

test("guardrail: oversized LIMIT is clamped, not just missing LIMIT injected", () => {
  const schema = introspect(demoDb());
  const g = applyGuardrails("SELECT id FROM customers LIMIT 500000", schema);
  assert.match(g.sql, /LIMIT 1000$/);
});

test("guardrail: EXPLAIN preflight rejects cartesian scans", () => {
  const db = demoDb();
  const violation = explainGuard(db, "SELECT * FROM events a, events b");
  assert.ok(violation && /rows/.test(violation), `expected row estimate rejection, got: ${violation}`);
  const fine = explainGuard(db, "SELECT id FROM customers WHERE id = 1");
  assert.equal(fine, null);
});

test("repair loop: bad SQL first, fixed SQL second → success with repairs=1", async () => {
  const db = demoDb();
  const replies = [
    "```sql\nSELECT id FROM not_a_real_table\n```",
    "```sql\nSELECT COUNT(*) AS n FROM orders\n```",
  ];
  let i = 0;
  const flaky: ChatProvider = {
    name: "flaky",
    async chat(_m: Message[], _t: ToolSpec[]) {
      return { text: replies[Math.min(i++, replies.length - 1)]!, toolCalls: [] };
    },
  };
  const res = await askSql(db, "how many orders", { provider: flaky, embedder: new MockEmbedder() });
  assert.equal(res.repairs, 1);
  assert.equal(Number(res.rows[0]?.n), 600);
  assert.equal(res.rejectedAttempts.length, 1);
});

test("ollama NDJSON parser", () => {
  assert.equal(parseOllamaLine('{"message":{"content":"SELECT"}}'), "SELECT");
  assert.equal(parseOllamaLine('{"done":true}'), "");
  assert.equal(parseOllamaLine("not json"), "");
  assert.equal(parseOllamaLine(""), "");
});

test("eval: resultsEqual is order-insensitive with numeric tolerance", () => {
  const a = [{ x: 1 }, { x: 2 }];
  const b = [{ x: 2 }, { x: 1 }];
  assert.ok(resultsEqual(a, b));
  const c = [{ v: 0.30000000004 }];
  const d = [{ v: 0.3 }];
  assert.ok(resultsEqual(c, d));
  assert.ok(!resultsEqual([{ x: 1 }], [{ x: 1 }, { x: 2 }]));
});

test("eval: attribution heuristic", () => {
  assert.equal(attribute("SELECT * FROM customers", "SELECT * FROM orders"), "schema");
  assert.equal(attribute("SELECT * FROM a JOIN b ON x JOIN a ON y", "SELECT * FROM a JOIN b ON x"), "join");
  assert.equal(attribute("SELECT 1", "SELECT 1"), "logic");
});
