import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedDemo } from "../src/sql/seed.ts";
import { proposeFromFailures, verifySemanticPatch } from "../src/sql/learn.ts";
import { MockEmbedder } from "../src/embed.ts";
import type { ChatProvider } from "../src/providers.ts";
import type { EvalQuestion } from "../src/sql/eval/eval.ts";

function demoDb() {
  const db = new DatabaseSync(":memory:");
  seedDemo(db);
  return db;
}

test("learn: failures classified into the right patch kinds", () => {
  const proposals = proposeFromFailures([
    { id: 7, attribution: "schema", sql: "SELECT 1" },
    { id: 12, attribution: "logic", sql: "SELECT 2" },
    { id: 15, attribution: "join", sql: "SELECT 3" },
  ]);
  assert.equal(proposals.length, 2); // join-class skipped by design
  assert.equal(proposals[0]!.kind, "tabledoc-hint");
  assert.equal(proposals[0]!.caseId, 7);
  assert.equal(proposals[1]!.kind, "semantic-term");
  assert.equal(proposals[1]!.caseId, 12);
  assert.ok(proposals.every((p) => !p.verified));
});

/** Provider that always misinterprets "revenue" unless the glossary note pins it. */
class ConditionalWrongProvider implements ChatProvider {
  name = "cond";
  constructor(private wrongSql: string, private rightSql: string, private trigger: string) {}
  async chat(messages: unknown[]) {
    const sys = JSON.stringify(messages[0]);
    const text = sys.includes(this.trigger) ? this.rightSql : this.wrongSql;
    return { text: "```sql\n" + text + "\n```", toolCalls: [] as never[] };
  }
}

test("learn: verifySemanticPatch detects fail→pass with the patch injected", async () => {
  const db = demoDb();
  const q: EvalQuestion = {
    id: 99, difficulty: "medium",
    q: "total revenue in cents",
    gt: "SELECT SUM(amount_cents) FROM payments",
  };
  const note = "revenue = SUM(payments.amount_cents) — payments is the monetary source of truth.";
  const provider = new ConditionalWrongProvider(
    "SELECT COUNT(*) FROM order_items", // wrong interpretation — provably different result
    "SELECT SUM(amount_cents) FROM payments", // correct once glossary pins it
    "payments is the monetary source of truth",
  );
  const v = await verifySemanticPatch(db, q, note, provider, new MockEmbedder());
  assert.equal(v.before, false, "without patch: wrong table interpretation");
  assert.equal(v.after, true, "with patch: correct");
  assert.equal(v.fixed, true, "fail→pass = verified fix");
});

test("learn: verifySemanticPatch reports not-fixed when the patch doesn't help", async () => {
  const db = demoDb();
  const q: EvalQuestion = {
    id: 98, difficulty: "medium",
    q: "total revenue in cents",
    gt: "SELECT SUM(amount_cents) FROM payments",
  };
  const provider = new ConditionalWrongProvider(
    "SELECT 1", // always wrong regardless
    "SELECT 1",
    "irrelevant-trigger",
  );
  const v = await verifySemanticPatch(db, q, "some note", provider, new MockEmbedder());
  assert.equal(v.fixed, false);
  assert.equal(v.after, false);
});
