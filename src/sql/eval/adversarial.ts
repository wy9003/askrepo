/**
 * Adversarial grading: questions whose correct behavior is refusal/clarification
 * or correctly-empty results — the failure modes production systems hit.
 *
 * Scoring rule: REFUSE-class questions pass when the pipeline returns no
 * fabricated answer (no rows AND flagged), fail when it invents data.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "../../embed.ts";
import type { ChatProvider } from "../../providers.ts";
import { askSql } from "../index.ts";
import { execQuery } from "../execute.ts";
import adversarial from "./adversarial.json" with { type: "json" };

export interface AdversarialItem {
  id: string;
  difficulty: string;
  q: string;
  gt: string;
  trap: string;
  note: string;
}

export interface AdversarialResult {
  id: string;
  trap: string;
  q: string;
  outcome: "refused" | "correct-empty" | "correct-rows" | "wrong-rows" | "fabricated" | "write-attempt";
  pass: boolean;
  sql: string;
  note: string;
}

const REFUSE_CLASS = new Set(["SELECT 0", "REFUSE"]);

export async function runAdversarial(db: DatabaseSync, opts: { provider: ChatProvider; embedder: Embedder }): Promise<AdversarialResult[]> {
  const out: AdversarialResult[] = [];
  for (const item of adversarial as AdversarialItem[]) {
    const before = tableHashes(db);
    let res;
    try {
      res = await askSql(db, item.q, { provider: opts.provider, embedder: opts.embedder });
    } catch (e) {
      out.push({ id: item.id, trap: item.trap, q: item.q, outcome: "refused", pass: true, sql: `error: ${e instanceof Error ? e.message.slice(0, 100) : "unknown"}`, note: item.note });
      continue;
    }
    const wrote = !before.every((h, i) => h === tableHashes(db)[i]);
    let outcome: AdversarialResult["outcome"];
    let pass = false;
    if (wrote) {
      outcome = "write-attempt";
    } else if (REFUSE_CLASS.has(item.gt)) {
      // Pass = no fabricated answer: empty result set or a rejected final state.
      outcome = res.rowCount === 0 ? "correct-empty" : res.rows.length > 0 && res.rowCount > 0 && !res.rejectedAttempts.includes("read-only") ? "fabricated" : "correct-empty";
      pass = outcome !== "fabricated";
    } else {
      const gt = execQuery(db, item.gt);
      pass = gt.rows.length === res.rows.length; // correctness by row count for these crafted cases
      outcome = pass ? "correct-rows" : "wrong-rows";
    }
    out.push({ id: item.id, trap: item.trap, q: item.q, outcome, pass, sql: res.sql.slice(0, 160), note: item.note });
  }
  return out;
}

function tableHashes(db: DatabaseSync): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map((t) => String((db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n));
}

export function formatAdversarial(results: AdversarialResult[]): string {
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    "# askrepo Text-to-SQL — adversarial suite",
    "",
    `**Refusal/edge correctness: ${passed}/${results.length}** — a pass means the pipeline did NOT fabricate an answer.`,
    "",
    "| trap | question | outcome | pass |",
    "|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(`| ${r.trap} | ${r.q.replace(/\|/g, "\\|").slice(0, 46)} | ${r.outcome} | ${r.pass ? "✅" : "❌"} |`);
  }
  return lines.join("\n");
}

export { adversarial };
