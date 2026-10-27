/**
 * askrepo's self-training loop (tier-1 with machine verification):
 *   report failures → patch proposals → LOCAL A/B VERIFICATION (patch on/off,
 *   re-run the failed questions) → only verified-fixes are marked for review.
 *
 * Two patch kinds:
 *  - semantic-term: a glossary entry that grounds a business concept the model
 *    got wrong (logic-class failures where tables/joins were right but the
 *    business interpretation differed).
 *  - tabledoc-hint: extra retrieval keywords for a table the schema-linking
 *    missed (schema-class failures).
 *
 * The verification step is what makes this loop stronger than a pure proposal:
 * a patch only ships with a "verified: fixed Q#7 (2/2)" tag after the machine
 * re-ran the failed questions with the patch applied in-memory. Humans review
 * *whether the fix is desirable*, not *whether it works*.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "../embed.ts";
import type { ChatProvider } from "../providers.ts";
import { askSql } from "./index.ts";
import { execQuery } from "./execute.ts";
import { introspect, type Schema } from "./introspect.ts";
import type { EvalQuestion } from "./eval/eval.ts";

export interface PatchProposal {
  kind: "semantic-term" | "tabledoc-hint";
  caseId: number;
  failureClass: string; // schema | join | logic
  reason: string;
  patch: string; // human-readable YAML fragment to merge into the glossary/doc
  verified: boolean;
  verification?: string; // "Q7 fail→pass with patch; no regression on Q21"
}

/** Generate proposals from failed eval rows. Conservative: only well-understood patterns. */
export function proposeFromFailures(
  failures: { id: number; attribution: string; sql?: string }[],
): PatchProposal[] {
  const out: PatchProposal[] = [];
  for (const f of failures) {
    if (f.attribution === "schema") {
      out.push({
        kind: "tabledoc-hint",
        caseId: f.id,
        failureClass: f.attribution,
        reason: "schema-linking missed a table — propose adding retrieval keywords to its doc (see generated fragment).",
        patch: `# In introspect.ts tableDoc() or a future doc-override map:\n#   "<table>": "table <table> (business keywords from question ${f.id})"`,
        verified: false,
      });
    } else if (f.attribution === "logic") {
      out.push({
        kind: "semantic-term",
        caseId: f.id,
        failureClass: f.attribution,
        reason: "tables/joins right, business interpretation wrong — propose a glossary term pinning the intended semantics.",
        patch: `{\n  term: "(REVIEW: the business concept in question ${f.id})",\n  definition: "(REVIEW: the suite's intended interpretation, see ground-truth SQL)",\n  synonyms: ["(REVIEW: key phrase from the question)"]\n}`,
        verified: false,
      });
    }
    // join-class failures: closure already eliminates them in practice; skip.
  }
  return out;
}

/** Machine verification: re-run the failing question with a glossary patch injected
 *  in-memory (extra system content). Returns fail→pass status for that question. */
export async function verifySemanticPatch(
  db: DatabaseSync,
  question: EvalQuestion,
  extraSystemNote: string,
  provider: ChatProvider,
  embedder: Embedder,
  schema?: Schema,
): Promise<{ fixed: boolean; before: boolean; after: boolean }> {
  const schemaReal = schema ?? introspect(db);
  const gt = execQuery(db, question.gt);
  const run = async (inject: boolean) => {
    const res = await askSql(db, question.q, {
      provider, embedder, schema: schemaReal,
      // The injection path: semanticNote is the extension point used by the glossary layer.
      ...(inject ? { extraSystemNote } : {}),
    });
    return rowsEqual(res.rows, gt.rows);
  };
  const before = await run(false); // likely false (this question failed)
  const after = await run(true);   // with the patch note injected
  return { fixed: !before && after, before, after };
}

function rowsEqual(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (rows: Record<string, unknown>[]) =>
    rows.map((r) => JSON.stringify(Object.values(r).map((v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : String(v))).sort())).sort();
  const na = norm(a), nb = norm(b);
  return na.every((row, i) => row === nb[i]);
}
