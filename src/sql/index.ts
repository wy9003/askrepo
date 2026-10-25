/** The Text-to-SQL pipeline: introspect → retrieve → FK closure → generate → guard → execute, with a repair loop. */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "../embed.ts";
import type { ChatProvider } from "../providers.ts";
import { introspect, tableDoc, type Schema } from "./introspect.ts";
import { selectTables, generateSQL } from "./generate.ts";
import { execQuery, type QueryResult } from "./execute.ts";
import { applyGuardrails, explainGuard } from "./guardrails.ts";
import { closure } from "./fkgraph.ts";
import { resolveTerms, semanticInstructions } from "./semantic.ts";

export interface AskOptions {
  provider: ChatProvider;
  embedder: Embedder;
  topK?: number;
  schema?: Schema; // pre-introspected (tests / repeated calls)
  closureEnabled?: boolean; // A/B switch for the eval harness (default true)
  maxRepairRounds?: number; // default 3
}

export interface AskResult extends QueryResult {
  sql: string;
  tablesUsed: string[];
  addedByClosure: string[];
  joins: string[];
  repairs: number;
  rejectedAttempts: string[];
}

export async function askSql(db: DatabaseSync, question: string, opts: AskOptions): Promise<AskResult> {
  const schema = opts.schema ?? introspect(db);
  const docs = schema.tables.map((t) => tableDoc(t, schema.foreignKeys));
  const [qv] = await opts.embedder.embed([question]);
  if (!qv) throw new Error("question embedding failed");

  // Rank tables by cosine similarity of their docs to the question.
  const docVecs = await opts.embedder.embed(docs);
  const scored = schema.tables
    .map((t, i) => ({ name: t.name, score: cosine(qv, docVecs[i]!) }))
    .sort((a, b) => b.score - a.score)
    .map((t) => t.name);

  const picked = opts.closureEnabled === false
    ? { tables: scored.slice(0, opts.topK ?? 4).map((n) => schema.tables.find((t) => t.name === n)!).filter(Boolean), added: [], joins: [] as string[] }
    : selectTables(schema.tables, schema.foreignKeys, scored, opts.topK ?? 4);
  const semantic = semanticInstructions(resolveTerms(question));
  const ctx = { dialect: "sqlite", tables: picked.tables, joins: picked.joins, question, semanticNote: semantic || undefined };

  let repairs = 0;
  const rejected: string[] = [];
  const maxRounds = opts.maxRepairRounds ?? 3;
  let feedback: string | undefined;

  for (let round = 0; round <= maxRounds; round++) {
    const raw = await generateSQL(opts.provider, ctx, feedback);
    const g = applyGuardrails(raw, schema);
    if (g.violations.length) {
      rejected.push(g.violations.join("; "));
      feedback = "Guardrail rejection: " + g.violations.join("; ");
      if (round < maxRounds) { repairs++; continue; }
      return { columns: [], rows: [], rowCount: 0, truncated: false, sql: g.sql, tablesUsed: ctx.tables.map((t) => t.name), addedByClosure: picked.added, joins: picked.joins, repairs, rejectedAttempts: rejected };
    }
    const scan = explainGuard(db, g.sql);
    if (scan) {
      rejected.push(scan);
      feedback = "Plan rejection: " + scan;
      if (round < maxRounds) { repairs++; continue; }
      return { columns: [], rows: [], rowCount: 0, truncated: false, sql: g.sql, tablesUsed: ctx.tables.map((t) => t.name), addedByClosure: picked.added, joins: picked.joins, repairs, rejectedAttempts: rejected };
    }
    try {
      const result = execQuery(db, g.sql);
      return { ...result, sql: g.sql, tablesUsed: ctx.tables.map((t) => t.name), addedByClosure: picked.added, joins: picked.joins, repairs, rejectedAttempts: rejected };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rejected.push("execution error: " + msg);
      feedback = "The database rejected the SQL with this error:\n" + msg;
      if (round < maxRounds) { repairs++; continue; }
      return { columns: [], rows: [], rowCount: 0, truncated: false, sql: g.sql, tablesUsed: ctx.tables.map((t) => t.name), addedByClosure: picked.added, joins: picked.joins, repairs, rejectedAttempts: rejected };
    }
  }
  throw new Error("unreachable");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export { introspect, tableDoc, closure };
