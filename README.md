# askrepo

**Chat with any codebase.** A small, dependency-free RAG + tool-using agent that indexes a repository and answers questions about it with file/line citations.

```
$ askrepo ask "where is rate limiting implemented?"
[step 1] [tool] search_docs {"query":"rate limit middleware"}
[step 2] [tool] read_file {"path":"src/middleware/ratelimit.ts","startLine":1,"endLine":60}
Rate limiting is implemented as Express middleware in src/middleware/ratelimit.ts:18-52.
A token bucket per client IP is created lazily on line 24 and refilled in `take()`
on line 37; requests exceeding the bucket get a 429 with `Retry-After` (line 48).
(3 steps, 2 tool calls)
```

## Why this exists

askrepo is a compact, readable demonstration of the patterns behind production
LLM features — small enough to read in one sitting, real enough to extend:

| Pattern | Where |
|---|---|
| RAG pipeline: scan → chunk → embed → retrieve | `src/scan.ts`, `src/chunk.ts`, `src/embed.ts`, `src/store.ts` |
| Agent loop with tool use (plan → call → observe → answer) | `src/agent.ts`, `src/tools.ts` |
| Hand-rolled OpenAI **and** Anthropic REST + SSE streaming, normalized to one interface | `src/providers.ts` |
| Cosine-similarity vector store with JSON persistence | `src/store.ts` |
| Path-confined file tools (no prompt-injected directory escapes) | `src/tools.ts` |
| Deterministic offline embedder so tests need no API keys | `src/embed.ts` |

**Zero runtime dependencies.** Everything above is built on `fetch` and the
Node standard library — which also makes the interesting parts easy to read
instead of hidden behind SDKs.

## Quickstart

```bash
git clone https://github.com/wy9003/askrepo && cd askrepo
npm install            # dev deps only (tsx, typescript)

export OPENAI_API_KEY=sk-...        # embeddings + chat
# export ANTHROPIC_API_KEY=sk-ant-...  # or use Claude for chat

npx tsx src/cli.ts index            # index the current repo
npx tsx src/cli.ts ask "how does the agent loop terminate?"
```

Switch chat providers with `--provider anthropic` (or `ASKREPO_CHAT_PROVIDER`).
Models default to `gpt-4o-mini` / `claude-sonnet-4-5` and can be overridden via
`ASKREPO_OPENAI_MODEL` / `ASKREPO_ANTHROPIC_MODEL`.

### No API key? Offline mode

```bash
npx tsx src/cli.ts index --offline
npx tsx src/cli.ts ask "anything" --offline   # retrieval-only: prints top chunks
```

Offline mode uses a deterministic trigram-hash embedder (not semantic, but it
exercises the whole pipeline) and skips the LLM entirely.

## How it works

```
            ┌──────────────────────── indexing ────────────────────────┐
            │                                                            │
 files ──►  scan (ext allowlist, skip node_modules, size caps)          │
        ──► chunk (line-aware, ~300-token target, 6-line overlap)       │
        ──► embed (OpenAI text-embedding-3-small, batched, retried)     │
        ──► store (cosine similarity, persisted to .askrepo/index.json) │
            └────────────────────────────────────────────────────────────┘

            ┌────────────────────────── asking ─────────────────────────┐
 question ─► agent loop (budget: --max-steps)                           │
        ─►  LLM (OpenAI / Anthropic, streamed SSE)                      │
        ─►  tool calls: search_docs / read_file / list_files            │
        ─►  grounded answer with path:startLine-endLine citations       │
            └────────────────────────────────────────────────────────────┘
```

Design notes:

- **Chunking** is line-aware instead of naive fixed-width slicing, so chunks
  never cut a line in half and always carry their 1-based line range — that is
  what makes citations trustworthy.
- **The vector store is hand-rolled on purpose.** At demo scale, exact cosine
  over a Float array is instant; the `add/search/save/load` surface maps 1:1
  onto Qdrant or pgvector when a corpus outgrows memory.
- **Providers are normalized** behind a 1-method interface (`chat`), with SSE
  accumulation implemented as pure functions (`accumulateOpenAI`,
  `accumulateAnthropic`) that are unit-tested against synthetic streams.
- **The agent loop is ~40 lines** and provider-agnostic: chat → tool calls →
  results → chat, with a hard step budget so a confused model cannot loop.

## Tests

```bash
npm test        # node:test — chunker, store, scanner, SSE accumulators, agent loop
npm run typecheck
```

All tests run offline; the mock embedder and scripted providers stand in for
the network.

## Limitations / roadmap

- Embeddings are OpenAI-only (Anthropic has no embeddings API). A local
  embedder (e.g. transformers.js) would remove the last online dependency of
  `index`.
- Single index per repo, no incremental re-indexing (file hashes would fix it).
- No re-ranking pass after retrieval; a small cross-encoder would lift precision.
- Chat history is per-question; a `--session` mode would allow follow-ups.

## License

[MIT](LICENSE) © Yu Wang
