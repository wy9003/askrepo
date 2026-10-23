/** Evaluation harness: run the question suite, score by execution equivalence, attribute errors. */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "../../embed.ts";
import type { ChatProvider } from "../../providers.ts";
import { askSql } from "../index.ts";
import { execQuery } from "../execute.ts";
import questions from "./questions.json" with { type: "json" };

export interface EvalQuestion {
  id: number;
  difficulty: "easy" | "medium" | "hard";
  q: string;
  gt: string;
  ambiguous?: boolean;
}

export interface EvalOptions {
  provider: ChatProvider;
  embedder: Embedder;
  limit?: number;
  closureEnabled?: boolean;
  label: string;
}

export interface EvalRun {
  label: string;
  closureEnabled: boolean;
  total: number;
  passed: number;
  byDifficulty: Record<string, { passed: number; total: number }>;
  attribution: Record<string, number>;
  repairs: number;
  rejected: number;
  durationMs: number;
  perQuestion: { id: number; difficulty: string; pass: boolean; attribution?: string; sql?: string; ambiguous?: boolean }[];
}

/** Order-insensitive result comparison with numeric tolerance.
 *  Known blind spot, accepted by design: rows are compared as multisets of
 *  cell values, so a result with two swapped columns of distinct types can
 *  false-pass. Ground-truth SQL in the suite avoids relying on this. */
export function resultsEqual(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (rows: Record<string, unknown>[]) =>
    rows
      .map((r) => Object.values(r).map(cell).sort())
      .map((r) => JSON.stringify(r))
      .sort();
  const na = norm(a), nb = norm(b);
  // Column names may differ; compare value multisets row by row.
  return na.every((row, i) => row === nb[i]);
}

function cell(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 1e4) / 1e4);
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

const TABLE_REF = /\b(?:from|join)\s+([a-zA-Z_][\w]*)/gi;
function tablesIn(sql: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  TABLE_REF.lastIndex = 0;
  while ((m = TABLE_REF.exec(sql))) out.add(m[1]!.toLowerCase());
  return out;
}

export function attribute(genSql: string, gtSql: string): string {
  const g = tablesIn(genSql), t = tablesIn(gtSql);
  if ([...g].some((x) => !t.has(x)) || [...t].some((x) => !g.has(x))) return "schema";
  const joinsGen = (genSql.match(/\bjoin\b/gi) ?? []).length;
  const joinsGt = (gtSql.match(/\bjoin\b/gi) ?? []).length;
  if (joinsGen !== joinsGt) return "join";
  return "logic";
}

export async function runEval(db: DatabaseSync, opts: EvalOptions): Promise<EvalRun> {
  const suite = (opts.limit ? (questions as EvalQuestion[]).slice(0, opts.limit) : questions as EvalQuestion[]);
  const run: EvalRun = {
    label: opts.label, closureEnabled: opts.closureEnabled !== false, total: suite.length, passed: 0,
    byDifficulty: {}, attribution: {}, repairs: 0, rejected: 0, durationMs: 0,
    perQuestion: [],
  };
  const t0 = Date.now();
  for (const item of suite) {
    const d = run.byDifficulty[item.difficulty] ?? { passed: 0, total: 0 };
    d.total++;
    try {
      const gtRes = execQuery(db, item.gt);
      const res = await askSql(db, item.q, {
        provider: opts.provider, embedder: opts.embedder, closureEnabled: opts.closureEnabled,
      });
      run.repairs += res.repairs;
      run.rejected += res.rejectedAttempts.length;
      const pass = resultsEqual(res.rows, gtRes.rows);
      if (pass) { run.passed++; d.passed++; }
      else run.attribution[attribute(res.sql, item.gt)] = (run.attribution[attribute(res.sql, item.gt)] ?? 0) + 1;
      run.perQuestion.push({ id: item.id, difficulty: item.difficulty, pass, attribution: pass ? undefined : attribute(res.sql, item.gt), sql: res.sql, ambiguous: item.ambiguous });
    } catch (e) {
      const why = e instanceof Error ? e.message.slice(0, 80) : String(e);
      run.attribution["error"] = (run.attribution["error"] ?? 0) + 1;
      run.perQuestion.push({ id: item.id, difficulty: item.difficulty, pass: false, attribution: "error:" + why });
    }
    run.byDifficulty[item.difficulty] = d;
  }
  run.durationMs = Date.now() - t0;
  return run;
}

export function formatReport(runs: EvalRun[]): string {
  const lines: string[] = ["# askrepo Text-to-SQL — eval report", ""];
  lines.push("| run | closure | accuracy | easy | medium | hard | schema | join | logic | error | repairs |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const pct = (x: { passed: number; total: number }) => x.total ? `${x.passed}/${x.total}` : "—";
    lines.push(
      `| ${r.label} | ${r.closureEnabled ? "on" : "off"} | **${Math.round((100 * r.passed) / Math.max(1, r.total))}%** (${r.passed}/${r.total}) | ${pct(r.byDifficulty.easy ?? { passed: 0, total: 0 })} | ${pct(r.byDifficulty.medium ?? { passed: 0, total: 0 })} | ${pct(r.byDifficulty.hard ?? { passed: 0, total: 0 })} | ${r.attribution.schema ?? 0} | ${r.attribution.join ?? 0} | ${r.attribution.logic ?? 0} | ${r.attribution.error ?? 0} | ${r.repairs} |`,
    );
  }
  return lines.join("\n");
}

export { questions };
