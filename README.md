# askrepo

**Two AI engineering demos in one zero-dependency TypeScript repo:**

1. **Chat with any codebase** — RAG + tool-using agent that answers questions about a repository with file-and-line citations.
2. **Text-to-SQL** — natural-language querying of a live database, with FK-graph join closure, deterministic guardrails, a self-repair loop, and a reproducible evaluation harness.

```
$ askrepo ask "where is rate limiting implemented?"
[tool] search_docs → [tool] read_file
Rate limiting lives in src/middleware/ratelimit.ts:18-52 … (3 steps, 2 tool calls)

$ askrepo sql ask "total revenue per customer country"
tables: customers, orders, payments (closure added: orders)
```sql
SELECT c.country, SUM(p.amount_cents) FROM customers c JOIN orders o ON o.customer_id=c.id
JOIN payments p ON p.order_id=o.id GROUP BY c.country
```
```

## Why this repo exists

It demonstrates the patterns behind production LLM features — small enough to read in one sitting, real enough to extend:

| Pattern | Where |
|---|---|
| RAG pipeline: scan → chunk → embed → retrieve | `src/scan.ts`, `src/chunk.ts`, `src/embed.ts`, `src/store.ts` |
| Agent loop with tool use and a step budget | `src/agent.ts`, `src/tools.ts` |
| Hand-rolled OpenAI **and** Anthropic REST/SSE streaming behind one interface | `src/providers.ts` |
| **Local inference (Ollama) as a first-class deployment mode** | `src/providers.ts` (`OllamaChat`) |
| Text-to-SQL: schema retrieval + generation + execution with repair | `src/sql/` |
| **FK-graph join-path closure** (see below) | `src/sql/fkgraph.ts` |
| **Deterministic guardrails** (model-independent) | `src/sql/guardrails.ts` |
| **Evaluation harness with execution-equivalence scoring & error attribution** | `src/sql/eval/` |

**Zero runtime dependencies.** Everything above is built on `fetch` and Node built-ins (`node:sqlite`, `node:test`) — the interesting parts stay readable instead of hidden behind SDKs.

## Text-to-SQL: the three ideas worth reading

### 1. FK-graph join closure (`src/sql/fkgraph.ts`)

Vector retrieval returns the *k* most relevant tables — but that set is often **not connected** in the foreign-key graph, so the model hallucinates join keys (valid SQL, silently wrong results). Closure grows the selected set with the shortest FK paths so the schema handed to the model is always join-complete. Pure graph code, no LLM:

```
retrieve {customers, products}  →  closure adds {orders, order_items}
                                   joins: orders.customer_id = customers.id
                                          order_items.order_id = orders.id
                                          order_items.product_id = products.id
```

### 2. Deterministic guardrails (`src/sql/guardrails.ts`)

Between the model and the database sit four checks that never depend on how smart the model is:

- **read-only enforcement** — every statement must start with `SELECT`/`WITH`; destructive keywords rejected outside string literals; multi-statements rejected
- **identifier verification** — every `FROM`/`JOIN` table must exist in the live catalog (hallucinated tables bounce)
- **LIMIT injection** — missing row caps are added before execution
- **EXPLAIN preflight** — the query plan's estimated scan cardinality (alias-resolved back to real tables) must stay under a threshold; cartesian products bounce

When a guardrail rejects, the violation is fed back to the model in a **self-repair loop** (≤3 rounds) — measured separately in the eval harness.

### 3. Evaluation as a first-class artifact (`src/sql/eval/`)

A 40-question suite (easy/medium/hard + deliberately ambiguous) over a deterministic seeded database, scored by **execution-result equivalence** (order-insensitive, numeric tolerance), with failed questions attributed to *schema / join / logic* classes. One command reproduces every number:

```bash
npx tsx src/cli.ts sql eval --provider openai          # full suite
npx tsx src/cli.ts sql eval --provider openai --ab     # with/without FK closure
npx tsx src/cli.ts sql eval --provider ollama          # fully local run
npx tsx src/cli.ts sql adv                              # adversarial suite
```

`--ab` answers the question that actually matters: **how many points does join-path closure add?**

**Measured** (via OpenAI-compatible endpoints, 2026-10-25):

| model | closure | accuracy | easy | medium | hard | failures by class |
|---|---|---|---|---|---|---|
| glm-4.7 | **on** | **83%** (33/40) | 15/15 | 12/15 | 6/10 | 1 schema · 1 join · 5 logic |
| glm-4.7 | off | 78% (31/40) | 15/15 | 10/15 | 6/10 | 2 schema · 7 logic |
| glm-5 | **on** | 80% (32/40) | 15/15 | 12/15 | 5/10 | 1 schema · 0 join · 7 logic |
| glm-5 | off | 75% (30/40) | 15/15 | 10/15 | 5/10 | 2 schema · 8 logic |

Two findings hold across models: **join errors go to zero with closure on** (the FK graph supplies the join paths), and the remaining failures concentrate in business-logic interpretation — the semantic layer, not plumbing. Newer ≠ better per-task: glm-5 trails glm-4.7 by 3 points on this suite.

The adversarial suite (`sql adv`) grades a different dimension — whether the pipeline *refuses to fabricate* on questions that have no honest answer. glm-4.7 scores **4/10**: guardrails caught 100% of destructive requests and hallucinated tables (code-level wins), but the model fabricates filters for undefined business terms 6/10 times ("inactive customers", "margin") — a measured motivation for a semantic/business-glossary layer.

## Deployment modes (data boundaries as configuration, not code)

The `ChatProvider` abstraction makes the LLM endpoint a config switch — the same pipeline runs in three data-boundary modes:

| mode | how | data leaves the machine? |
|---|---|---|
| Public API | `--provider openai` / `anthropic` | yes |
| Fully local | `--provider ollama` (`OLLAMA_BASE_URL`, `ASKREPO_OLLAMA_MODEL`) | never |

## Quickstart

```bash
git clone https://github.com/wy9003/askrepo && cd askrepo
npm install            # dev deps only (tsx, typescript)

# Text-to-SQL (offline smoke, no keys):
npx tsx src/cli.ts sql init                     # seed the demo e-commerce DB
npx tsx src/cli.ts sql ask "how many orders" --offline

# Text-to-SQL (real, with any provider):
export OPENAI_API_KEY=sk-...                    # or ANTHROPIC_API_KEY, or run Ollama
npx tsx src/cli.ts sql ask "top 5 products by units sold"

# Codebase Q&A (v1):
npx tsx src/cli.ts index && npx tsx src/cli.ts ask "how does the agent loop terminate?"
```

## Tests

```bash
npm test          # 27 tests: chunker, store, scanner, SSE accumulators, agent loop,
                  # FK closure, guardrails (incl. DROP-table / hallucinated-table /
                  # cartesian-scan attack cases), repair loop, eval comparator
npm run typecheck
```

All tests run offline; mock embedders and scripted providers stand in for the network.

## Repository layout

```
src/
  cli.ts            entry: index | ask | sql init | sql ask | sql eval
  agent.ts tools.ts # v1: tool-using agent loop
  scan.ts chunk.ts  # v1: repo scanning + line-aware chunking
  embed.ts store.ts # embeddings (OpenAI / mock) + cosine store
  providers.ts      OpenAI / Anthropic SSE + Ollama NDJSON behind one interface
  sql/
    seed.ts         deterministic synthetic e-commerce DB (9 tables)
    introspect.ts   tables/columns/FKs from the live catalog
    fkgraph.ts      FK-graph join-path closure
    generate.ts     dialect-aware prompt assembly + SQL extraction
    guardrails.ts   read-only / identifiers / LIMIT / EXPLAIN preflight
    execute.ts      execution
    index.ts        pipeline with self-repair loop
    eval/           40-question suite + scoring + attribution + report
```

## License

[MIT](LICENSE) © Yu Wang
