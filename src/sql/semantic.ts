/**
 * Semantic layer: a business glossary that grounds domain terms before
 * generation, and flags ungrounded business terms so the model declines
 * rather than fabricates.
 *
 * Measured motivation (2026-10-25): glm-4.7 fabricates filters for undefined
 * business terms 6/10 times in the adversarial suite. Goal: ≤3/10.
 */

export interface GlossaryEntry {
  /** Canonical term shown to the model. */
  term: string;
  /** Grounded SQL-ready definition (dialect: SQLite). */
  definition: string;
  /** How it's expressed in user questions. */
  synonyms: string[];
}

export interface TermResolution {
  grounded: { term: string; definition: string; matched: string }[];
  ungrounded: string[];
}

const GLOSSARY: GlossaryEntry[] = [
  {
    term: "revenue",
    definition: "revenue = SUM(payments.amount_cents). The payments table is the monetary source of truth; order_items prices are pre-discount and must NOT be used for revenue.",
    synonyms: ["revenue", "income", "sales amount", "total sales", "turnover"],
  },
  {
    term: "active customer",
    definition: "active customer = a customer with at least one event of any type in the last 30 days of the dataset.",
    synonyms: ["active", "active customer", "active user", "engaged"],
  },
  {
    term: "churned customer",
    definition: "churned customer = a customer with NO orders placed in the last 90 days of the dataset (and at least one earlier order).",
    synonyms: ["churned", "churn", "lapsed", "lost customer"],
  },
  {
    term: "units sold",
    definition: "units sold = SUM(order_items.qty) across all order items (regardless of order status).",
    synonyms: ["units sold", "quantity sold", "total units", "sold quantity"],
  },
  {
    term: "best-selling product",
    definition: "best-selling = highest SUM(order_items.qty), i.e. by units, not by revenue.",
    synonyms: ["best-selling", "most popular", "top-selling"],
  },
];

/** Word-boundary matcher over the question, longest-synonym first. */
export function resolveTerms(question: string): TermResolution {
  const grounded: TermResolution["grounded"] = [];
  const ungrounded: string[] = [];
  const q = " " + question.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";

  // Business words that carry domain meaning but have NO grounding in this schema.
  const UNGROUNDED_SIGNALS = ["inactive", "margin", "profit", "tax", "taxes", "vat", "churn rate", "retention", "loyalty", "vip", "premium", "debt", "credit"];

  const matchedPositions: [number, number][] = [];
  const sorted = GLOSSARY.flatMap((g) => g.synonyms.map((s) => ({ g, s }))).sort((a, b) => b.s.length - a.s.length);
  for (const { g, s } of sorted) {
    const idx = q.indexOf(" " + s + " ");
    if (idx < 0) continue;
    if (matchedPositions.some(([a, b]) => idx >= a - 1 && idx < b)) continue; // overlap with an already-matched longer term
    matchedPositions.push([idx, idx + s.length + 2]);
    if (!grounded.some((x) => x.term === g.term)) grounded.push({ term: g.term, definition: g.definition, matched: s });
  }

  for (const w of UNGROUNDED_SIGNALS) {
    if (q.includes(" " + w + " ") && !grounded.some((g) => g.matched.includes(w))) ungrounded.push(w);
  }

  return { grounded, ungrounded };
}

/** System-prompt section for the semantic layer. */
export function semanticInstructions(res: TermResolution): string {
  const parts: string[] = [];
  if (res.grounded.length) {
    parts.push(
      "Business term definitions (authoritative — follow them exactly):\n" +
        res.grounded.map((g) => `- ${g.term}: ${g.definition}`).join("\n"),
    );
  }
  if (res.ungrounded.length) {
    parts.push(
      `The following business term(s) appear in the question but have NO definition in this database: ${res.ungrounded.join(", ")}.\n` +
        "There is no column or data supporting them. Do NOT invent a filter or estimation for them.\n" +
        "If the question cannot be answered without them, return exactly:\n" +
        "```sql\nSELECT 'NOT_ANSWERABLE: <term> is not defined in this schema' AS error\n```",
    );
  }
  return parts.join("\n\n");
}
