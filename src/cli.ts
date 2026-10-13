#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "./chunk.ts";
import { MockEmbedder, OpenAIEmbedder, type Embedder } from "./embed.ts";
import { runAgent } from "./agent.ts";
import { AnthropicChat, OpenAIChat, type ChatProvider } from "./providers.ts";
import { scanRepo } from "./scan.ts";
import { VectorStore } from "./store.ts";
import { createToolExecutor } from "./tools.ts";

const INDEX_FILE = ".askrepo/index.json";

interface Args {
  command: "index" | "ask" | "help";
  root: string;
  provider: string;
  offline: boolean;
  topK: number;
  maxSteps: number;
  question: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "help",
    root: process.cwd(),
    provider: process.env.ASKREPO_CHAT_PROVIDER || "openai",
    offline: !!process.env.ASKREPO_OFFLINE,
    topK: 5,
    maxSteps: 8,
    question: "",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root") args.root = argv[++i] ?? args.root;
    else if (a === "--provider") args.provider = argv[++i] ?? args.provider;
    else if (a === "--offline") args.offline = true;
    else if (a === "--top-k") args.topK = Number(argv[++i]) || args.topK;
    else if (a === "--max-steps") args.maxSteps = Number(argv[++i]) || args.maxSteps;
    else rest.push(a);
  }
  if (rest[0] === "index" || rest[0] === "ask") args.command = rest[0];
  if (rest[0] === "ask") args.question = rest.slice(1).join(" ");
  return args;
}

function makeEmbedder(offline: boolean): Embedder {
  if (offline) return new MockEmbedder();
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error("Set OPENAI_API_KEY (or pass --offline for the mock embedder).");
    process.exit(1);
  }
  return new OpenAIEmbedder(key);
}

function makeChatProvider(name: string): ChatProvider {
  if (name === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error("Set ANTHROPIC_API_KEY."); process.exit(1); }
    return new AnthropicChat(key);
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error("Set OPENAI_API_KEY."); process.exit(1); }
  return new OpenAIChat(key);
}

async function cmdIndex(args: Args): Promise<void> {
  const embedder = makeEmbedder(args.offline);
  console.error(`Scanning ${args.root} …`);
  const files = await scanRepo(args.root);
  console.error(`Found ${files.length} files. Chunking…`);

  const chunks = files.flatMap((f) => chunkText(f.text, f.path));
  console.error(`${chunks.length} chunks. Embedding (${args.offline ? "mock" : "openai"})…`);

  const store = new VectorStore();
  const BATCH = 200;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await embedder.embed(batch.map((c) => c.text));
    store.add(batch, vecs);
    process.stderr.write(`  ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\n`);
  }

  const out = join(args.root, INDEX_FILE);
  await store.save(out);
  console.error(`Saved ${store.size} chunks → ${out}`);
}

async function cmdAsk(args: Args): Promise<void> {
  if (!args.question) { console.error('Usage: askrepo ask "your question"'); process.exit(1); }
  const index = join(args.root, INDEX_FILE);
  if (!existsSync(index)) { console.error(`No index at ${index}. Run "askrepo index" first.`); process.exit(1); }

  const store = await VectorStore.load(index);
  const embedder = makeEmbedder(args.offline);

  if (args.offline) {
    // Retrieval-only mode: show what the agent would retrieve, no LLM call.
    const [vec] = await embedder.embed([args.question]);
    for (const { chunk, score } of store.search(vec!, args.topK)) {
      console.log(`### ${chunk.path}:${chunk.startLine}-${chunk.endLine} (score ${score.toFixed(3)})\n${chunk.text}\n`);
    }
    return;
  }

  const provider = makeChatProvider(args.provider);
  const run = await runAgent(provider, createToolExecutor(args.root, store, embedder), args.question, {
    maxSteps: args.maxSteps,
    events: {
      onToolCall: (name, a) => process.stderr.write(`\x1b[2m[tool] ${name} ${a}\x1b[0m\n`),
      onToken: (t) => process.stdout.write(t),
      onStep: (s) => process.stderr.write(`\x1b[2m[step ${s}]\x1b[0m `),
    },
  });
  process.stdout.write("\n");
  process.stderr.write(`\x1b[2m(${run.steps} steps, ${run.toolCalls} tool calls)\x1b[0m\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "index") await cmdIndex(args);
else if (args.command === "ask") await cmdAsk(args);
else {
  console.log(`askrepo — chat with any codebase (RAG + tool-using agent)

Usage:
  askrepo index [--root DIR] [--offline]     scan + chunk + embed a repo
  askrepo ask "question" [--provider NAME]   ask the agent (streams the answer)

Options:
  --root DIR        repo root (default: cwd)
  --provider NAME   openai | anthropic (default: \${ASKREPO_CHAT_PROVIDER:-openai})
  --offline         mock embeddings + retrieval-only answers, no API keys
  --top-k K         chunks per retrieval (default 5)
  --max-steps N     agent tool-step budget (default 8)

Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, ASKREPO_OPENAI_MODEL, ASKREPO_ANTHROPIC_MODEL`);
}
