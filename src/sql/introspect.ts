/** Database introspection: tables, columns, foreign keys, DDL — from the live catalog. */
import type { DatabaseSync } from "node:sqlite";

export interface ColumnMeta {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  ddl: string;
}

export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface Schema {
  tables: TableMeta[];
  foreignKeys: ForeignKey[];
}

export function introspect(db: DatabaseSync): Schema {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];

  const tables: TableMeta[] = rows.map((r) => ({
    name: r.name,
    ddl: r.sql,
    columns: (db.prepare(`PRAGMA table_info(${q(r.name)})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map(
      (c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, pk: !!c.pk }),
    ),
  }));

  const foreignKeys: ForeignKey[] = [];
  for (const t of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${q(t.name)})`).all() as {
      table: string;
      from: string;
      to: string;
    }[];
    for (const fk of fks) {
      foreignKeys.push({ fromTable: t.name, fromColumn: fk.from, toTable: fk.table, toColumn: fk.to });
    }
  }
  return { tables, foreignKeys };
}

/** Per-table document for retrieval: name, columns, and a comment about FKs — enough signal for embedding. */
export function tableDoc(t: TableMeta, fks: ForeignKey[]): string {
  const fkNotes = fks
    .filter((f) => f.fromTable === t.name)
    .map((f) => `${f.fromColumn} -> ${f.toTable}.${f.toColumn}`);
  const cols = t.columns.map((c) => `${c.name}${c.type ? ":" + c.type : ""}`).join(", ");
  return `table ${t.name} (${cols})${fkNotes.length ? " | refs: " + fkNotes.join("; ") : ""}`;
}

function q(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
