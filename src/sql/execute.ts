/** SQL execution against a live DatabaseSync connection. Guardrails land in W2; W1 keeps it honest but bare. */
import type { DatabaseSync } from "node:sqlite";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const DISPLAY_CAP = 200;

export function execQuery(db: DatabaseSync, sql: string): QueryResult {
  const stmt = db.prepare(sql);
  const raw = stmt.all() as Record<string, unknown>[];
  const columns = stmt.columns().map((c: { name: string }) => c.name);
  const truncated = raw.length > DISPLAY_CAP;
  return { columns, rows: truncated ? raw.slice(0, DISPLAY_CAP) : raw, rowCount: raw.length, truncated };
}
