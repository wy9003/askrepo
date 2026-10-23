/** The Text-to-SQL pipeline: introspect → retrieve → FK closure → generate → execute. */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "../embed.ts";
import type { ChatProvider } from "../providers.ts";
import { introspect, tableDoc, type Schema } from "./introspect.ts";
import { selectTables, generateSQL } from "./generate.ts";
import { execQuery, type QueryResult } from "./execute.ts";

export interface AskOptions {
  provider: ChatProvider;
  embedder: Embedder;
  topK?: number;
  schema?: Schema; // pre-introspected (tests / repeated calls)
}

export interface AskResult extends QueryResult {
  sql: string;
  tablesUsed: string[];
  addedByClosure: string[];
  joins: string[];
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

  const { tables, added, joins } = selectTables(schema.tables, schema.foreignKeys, scored, opts.topK ?? 4);
  const sql = await generateSQL(opts.provider, { dialect: "sqlite", tables, joins, question });
  const result = execQuery(db, sql);
  return { ...result, sql, tablesUsed: tables.map((t) => t.name), addedByClosure: added, joins };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export { introspect, tableDoc };
