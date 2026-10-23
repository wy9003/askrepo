/** Prompt assembly and SQL extraction for NL → SQL. */
import type { ChatProvider } from "../providers.ts";
import type { ForeignKey, TableMeta } from "./introspect.ts";
import { closure } from "./fkgraph.ts";

export interface SqlContext {
  dialect: string;
  tables: TableMeta[]; // selected (post-closure) tables
  joins: string[]; // FK join conditions
  question: string;
}

export const SQL_SYSTEM_PROMPT = `You are an expert SQL analyst. You translate a natural-language question into ONE SQL query.

Rules:
- Target dialect: SQLite.
- Emit a single SELECT or WITH…SELECT statement only. Never INSERT/UPDATE/DELETE/DDL.
- Use only the tables and columns provided in the schema. Do not invent tables, columns, or join keys.
- Prefer the join conditions listed under "Joins" when combining tables.
- If the question is ambiguous, choose the most common business interpretation and proceed.
- Output ONLY the SQL inside one \`\`\`sql fenced block. No prose before or after.`;

export function buildSqlMessages(ctx: SqlContext, repairNote?: string) {
  const schema = ctx.tables.map((t) => t.ddl + ";").join("\n\n");
  const joins = ctx.joins.length ? ctx.joins.map((j) => `- ${j}`).join("\n") : "- (single table)";
  const messages = [
    { role: "system" as const, content: SQL_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Schema (SQLite DDL):\n\n${schema}\n\nJoins (foreign keys):\n${joins}\n\nQuestion: ${ctx.question}\n\nReturn the SQL.`,
    },
  ];
  if (repairNote) {
    messages.push({
      role: "user" as const,
      content: `Your previous attempt was rejected:\n${repairNote}\n\nFix the SQL and return it. Same rules: only the \`\`\`sql block.`,
    });
  }
  return messages;
}

/** Pull the SQL out of a model reply: ```sql fence first, else first SELECT/WITH statement. */
export function extractSQL(text: string): string {
  const fence = text.match(/```sql\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] ?? text : text).trim();
  const stmt = candidate.match(/((?:WITH|SELECT)[\s\S]*?)(?:;|$)/i);
  return (stmt ? stmt[1] ?? candidate : candidate).replace(/;\s*$/, "").trim();
}

export async function generateSQL(provider: ChatProvider, ctx: SqlContext, repairNote?: string): Promise<string> {
  const res = await provider.chat(buildSqlMessages(ctx, repairNote), [], {});
  const sql = extractSQL(res.text);
  if (!sql) throw new Error("model returned no SQL");
  return sql;
}

/** Convenience: pick tables by retrieval then close the FK graph. */
export function selectTables(
  allTables: TableMeta[],
  foreignKeys: ForeignKey[],
  ranked: string[],
  topK = 4,
): { tables: TableMeta[]; added: string[]; joins: string[] } {
  const selected = ranked.slice(0, topK).filter((n) => allTables.some((t) => t.name === n));
  const c = closure(selected, foreignKeys);
  const byName = new Map(allTables.map((t) => [t.name, t] as const));
  return { tables: c.tables.map((n) => byName.get(n)!).filter(Boolean), added: c.added, joins: c.joins };
}
