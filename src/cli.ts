#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "./chunk.ts";
import { MockEmbedder, OpenAIEmbedder, type Embedder } from "./embed.ts";
import { runAgent } from "./agent.ts";
import { AnthropicChat, OpenAIChat, OllamaChat, type ChatProvider } from "./providers.ts";
import { scanRepo } from "./scan.ts";
import { VectorStore } from "./store.ts";
import { createToolExecutor } from "./tools.ts";

const INDEX_FILE = ".askrepo/index.json";

interface Args {
  command: "index" | "ask" | "sql" | "help";
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
  if (rest[0] === "index" || rest[0] === "ask" || rest[0] === "sql") args.command = rest[0];
  if (rest[0] === "ask") args.question = rest.slice(1).join(" ");
  if (rest[0] === "sql") args.question = rest.slice(1).join(" "); // "init" | "ask <question>"
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
  if (name === "ollama") return new OllamaChat();
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
else if (args.command === "sql") {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdir } = await import("node:fs/promises");
  const sub = args.question.split(" ")[0]; // sql subcommand stored in question slot
  const question = args.question.split(" ").slice(1).join(" ");
  const dbPath = join(args.root, ".askrepo/demo.db");
  await mkdir(join(args.root, ".askrepo"), { recursive: true });
  if (sub === "init") {
    const { seedDemo } = await import("./sql/seed.ts");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = MEMORY");
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
      db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    }
    seedDemo(db);
    console.error(`Seeded demo database → ${dbPath}`);
  } else if (sub === "ask") {
    if (!question) { console.error('Usage: askrepo sql ask "your question"'); process.exit(1); }
    const { askSql } = await import("./sql/index.ts");
    const { MockEmbedder } = await import("./embed.ts");
    const { ScriptedSqlProvider } = await import("./sql/offline.ts");
    const provider = args.offline ? new ScriptedSqlProvider() : makeChatProvider(args.provider);
    const embedder = args.offline ? new MockEmbedder() : makeEmbedder(args.offline);
    const db = new DatabaseSync(dbPath);
    const res = await askSql(db, question, { provider, embedder });
    console.error(`tables: ${res.tablesUsed.join(", ")}${res.addedByClosure.length ? " (closure added: " + res.addedByClosure.join(", ") + ")" : ""}`);
    console.log(`\`\`\`sql\n${res.sql}\n\`\`\``);
    console.log(`rows: ${res.rowCount}${res.truncated ? " (truncated)" : ""}`);
    console.table(res.rows.slice(0, 20));
  } else if (sub === "eval") {
    const { seedDemo } = await import("./sql/seed.ts");
    const { runEval, formatReport } = await import("./sql/eval/eval.ts");
    const { ScriptedSqlProvider } = await import("./sql/offline.ts");
    const limitIdx = process.argv.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) || undefined : undefined;
    const ab = process.argv.includes("--ab");
    const db = new DatabaseSync(":memory:");
    seedDemo(db); // deterministic suite — eval is reproducible by construction
    const provider = args.offline ? new ScriptedSqlProvider() : makeChatProvider(args.provider);
    const embedder = args.offline ? new MockEmbedder() : makeEmbedder(args.offline);
    const label = args.offline ? "scripted(offline)" : provider.name;
    const runs = [await runEval(db, { provider, embedder, limit, closureEnabled: true, label })];
    if (ab) runs.push(await runEval(db, { provider, embedder, limit, closureEnabled: false, label: label + " · no-closure" }));
    const report = formatReport(runs);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(args.root, ".askrepo/eval-report.md"), report);
    console.log(report);
    console.error(`\nreport → ${join(args.root, ".askrepo/eval-report.md")}`);
  } else {
    console.error('Usage: askrepo sql init | ask "question" | eval [--limit N] [--ab]');
    process.exit(1);
  }
} else {
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
