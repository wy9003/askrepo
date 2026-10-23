/**
 * FK-graph join-path closure.
 *
 * Vector retrieval returns the k most relevant tables, but that set is often
 * NOT connected in the foreign-key graph — the model then hallucinates join
 * keys. Closure() grows the selected set with the shortest FK paths so the
 * schema handed to the LLM is always join-complete. Pure deterministic code.
 */
import type { ForeignKey } from "./introspect.ts";

export interface ClosureResult {
  /** Selected tables plus the intermediates needed to connect them. */
  tables: string[];
  /** Intermediate tables that were added. */
  added: string[];
  /** FK edges (as join conditions) spanning the final set. */
  joins: string[];
}

export function closure(selected: string[], foreignKeys: ForeignKey[]): ClosureResult {
  if (selected.length <= 1) return { tables: [...selected], added: [], joins: [] };

  const adj = new Map<string, Map<string, ForeignKey>>();
  const addEdge = (a: string, b: string, fk: ForeignKey) => {
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, fk);
    adj.get(b)!.set(a, fk);
  };
  for (const fk of foreignKeys) addEdge(fk.fromTable, fk.toTable, fk);

  // Greedy Steiner approximation: grow a connected union by repeatedly
  // attaching the nearest remaining selected table via BFS shortest path.
  const remaining = new Set(selected.slice(1));
  const inTree = new Set<string>([selected[0]!]);
  const usedFks = new Set<ForeignKey>();

  while (remaining.size > 0) {
    let best: { table: string; path: string[]; fks: ForeignKey[] } | null = null;
    for (const target of remaining) {
      const found = bfs(target, inTree, adj);
      if (found && (!best || found.path.length < best.path.length)) best = { table: target, ...found };
    }
    if (!best) break; // selected set has an isolated table (no FK path) — nothing we can do
    for (const t of best.path) inTree.add(t);
    for (const fk of best.fks) usedFks.add(fk);
    remaining.delete(best.table);
  }

  const tables = [...inTree].sort();
  const added = tables.filter((t) => !selected.includes(t));
  const joins = [...usedFks].map((fk) => `${fk.fromTable}.${fk.fromColumn} = ${fk.toTable}.${fk.toColumn}`);
  return { tables, added, joins };
}

function bfs(from: string, targets: Set<string>, adj: Map<string, Map<string, ForeignKey>>) {
  const prev = new Map<string, { node: string; fk: ForeignKey }>();
  const seen = new Set([from]);
  let queue: string[] = [from];
  let hit: string | null = null;
  while (queue.length && !hit) {
    const next: string[] = [];
    for (const node of queue) {
      for (const [nb, fk] of adj.get(node) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, { node, fk });
        if (targets.has(nb)) { hit = nb; break; }
        next.push(nb);
      }
      if (hit) break;
    }
    queue = next;
  }
  if (!hit) return null;
  const path: string[] = [];
  const fks: ForeignKey[] = [];
  for (let cur = hit; cur !== from; ) {
    path.push(cur);
    const p = prev.get(cur)!;
    fks.push(p.fk);
    cur = p.node;
  }
  path.push(from);
  return { path, fks };
}
