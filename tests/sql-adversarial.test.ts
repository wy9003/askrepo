import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedDemo } from "../src/sql/seed.ts";
import { runAdversarial } from "../src/sql/eval/adversarial.ts";
import { MockEmbedder } from "../src/embed.ts";
import type { ChatProvider } from "../src/providers.ts";
import type { Message, ToolSpec } from "../src/types.ts";
import { applyGuardrails } from "../src/sql/guardrails.ts";
import { introspect } from "../src/sql/introspect.ts";

/** Provider that answers every question with the same canned COUNT — the
 *  fabrication machine: adversarial grading must catch it. */
class CannedCountProvider implements ChatProvider {
  name = "canned";
  async chat(): Promise<{ text: string; toolCalls: never[] }> {
    return { text: "```sql\nSELECT COUNT(*) AS n FROM orders\n```", toolCalls: [] as never[] };
  }
}

test("adversarial: a canned-answer model is graded as fabricating", async () => {
  const db = new DatabaseSync(":memory:");
  seedDemo(db);
  const results = await runAdversarial(db, { provider: new CannedCountProvider(), embedder: new MockEmbedder() });
  assert.equal(results.length, 10);
  const fabricated = results.filter((r) => r.outcome === "fabricated");
  // 8 refuse-class questions (adv1-5,7,9,10) must all be caught fabricating.
  assert.equal(fabricated.length, 8);
  // The destructive request must never pass through as a successful write.
  const del = results.find((r) => r.trap === "destructive-request")!;
  assert.ok(["fabricated", "write-attempt", "refused"].includes(del.outcome));
  assert.equal(del.outcome, "fabricated"); // canned model "answers" it with a count — graded fail
});

test("adversarial: honest-empty provider passes the refuse class", async () => {
  const db = new DatabaseSync(":memory:");
  seedDemo(db);
  // A model that always queries something that legitimately returns zero rows.
  const honest: ChatProvider = {
    name: "honest-empty",
    async chat(): Promise<{ text: string; toolCalls: never[] }> {
      return { text: "```sql\nSELECT id FROM customers WHERE 1=0\n```", toolCalls: [] as never[] };
    },
  };
  const results = await runAdversarial(db, { provider: honest, embedder: new MockEmbedder() });
  const refuseClass = results.filter((r) => r.id.startsWith("adv") && r.outcome !== "correct-rows" && r.outcome !== "wrong-rows");
  assert.ok(refuseClass.every((r) => r.pass), JSON.stringify(refuseClass.map((r) => ({ id: r.id, o: r.outcome }))));
});

test("guardrail still blocks DELETE even when wrapped in CTE lipstick", () => {
  const schema = introspect(new DatabaseSync(":memory:") as never); // FK set unused for this check
  const g = applyGuardrails("WITH x AS (SELECT 1) DELETE FROM events WHERE occurred_at < '2025-01-01'", schema);
  assert.ok(g.violations.length > 0, "CTE-wrapped DELETE must violate guardrails");
});
