/**
 * Deterministic guardrails between the LLM and the database.
 * All checks are pure code — model-independent by design.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Schema } from "./introspect.ts";

export interface GuardOptions {
  maxRows?: number; // LIMIT injected when absent (default 1000)
  scanThreshold?: number; // reject queries whose plan scans more rows than this (default 1_000_000)
}

export interface GuardResult {
  sql: string;
  violations: string[]; // non-empty ⇒ the query must be sent back for repair
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b/i;
const TABLE_REF = /\b(?:from|join)\s+([a-zA-Z_][\w]*)/gi;

export function applyGuardrails(rawSql: string, schema: Schema, opts: GuardOptions = {}): GuardResult {
  const maxRows = opts.maxRows ?? 1000;
  const violations: string[] = [];
  let sql = rawSql.trim().replace(/;+\s*$/, "");

  // 1) Read-only: every statement must start with SELECT or WITH.
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length === 0) violations.push("empty statement");
  for (const st of statements) {
    if (!/^(select|with)\b/i.test(st)) violations.push(`non-read-only statement: ${st.slice(0, 40)}…`);
  }

  // 2) No destructive keywords outside string literals (heuristic, documented).
  const withoutStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const kw = withoutStrings.match(FORBIDDEN);
  if (kw) violations.push(`forbidden keyword(s): ${[...new Set(kw.map((k) => k.toUpperCase()))].join(", ")}`);

  // 3) Identifier check: every FROM/JOIN table must exist in the catalog.
  const known = new Set(schema.tables.map((t) => t.name.toLowerCase()));
  let m: RegExpExecArray | null;
  TABLE_REF.lastIndex = 0;
  const unknown = new Set<string>();
  while ((m = TABLE_REF.exec(withoutStrings))) {
    const t = m[1]!.toLowerCase();
    if (!known.has(t)) unknown.add(m[1]!);
  }
  if (unknown.size) violations.push(`unknown table(s): ${[...unknown].join(", ")}`);

  // 4) LIMIT injection when absent.
  if (violations.length === 0 && !/\blimit\b/i.test(withoutStrings)) sql += ` LIMIT ${maxRows}`;

  return { sql, violations };
}

/** EXPLAIN preflight: reject plans whose estimated scanned rows exceed the threshold. */
export function explainGuard(db: DatabaseSync, sql: string, opts: GuardOptions = {}): string | null {
  const threshold = opts.scanThreshold ?? 1_000_000;
  let plan: { detail: string }[] = [];
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  } catch {
    return `EXPLAIN failed: query is not executable`; // caller sends it back for repair
  }
  const scanned = [...plan.map((p) => p.detail).join("\n").matchAll(/\bSCAN\s+([A-Za-z_][\w]*)/g)].map((x) => x[1]!);
  if (scanned.length === 0) return null;
  // EQP prints aliases; resolve them back to real tables via FROM/JOIN clauses
  // (including comma-separated FROM lists: "FROM events a, events b").
  const aliasToTable = new Map<string, string>();
  const refRe = /\b(?:from|join)\s+([a-zA-Z_]\w*(?:\s+(?:as\s+)?[a-zA-Z_]\w*)?(?:\s*,\s*[a-zA-Z_]\w*(?:\s+(?:as\s+)?[a-zA-Z_]\w*)?)*)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = refRe.exec(sql))) {
    for (const part of rm[1]!.split(",")) {
      const ids = part.trim().split(/\s+(?:as\s+)?/i);
      const table = ids[0]?.toLowerCase();
      const alias = ids[1]?.toLowerCase();
      if (table) aliasToTable.set(alias ?? table, table);
    }
  }
  const counts = new Map<string, number>();
  for (const name of new Set(scanned)) {
    const table = aliasToTable.get(name.toLowerCase()) ?? name.toLowerCase();
    if (!counts.has(table)) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | undefined;
        counts.set(table, r?.n ?? 0);
      } catch {
        /* unknown name — identifier check catches it upstream */
      }
    }
  }
  // Rough cardinality estimate: product of row counts across full scans.
  let estimate = 1;
  for (const name of scanned) estimate *= Math.max(1, counts.get(aliasToTable.get(name.toLowerCase()) ?? name.toLowerCase()) ?? 1);
  return estimate > threshold ? `plan scans ~${estimate.toLocaleString()} rows (threshold ${threshold.toLocaleString()}) — add filters or joins on keys` : null;
}
