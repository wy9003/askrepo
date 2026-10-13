import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Embedder } from "./embed.ts";
import { VectorStore } from "./store.ts";
import type { ToolCall, ToolSpec } from "./types.ts";

/** Tool surface exposed to the LLM. */
export function buildToolSpecs(): ToolSpec[] {
  return [
    {
      name: "search_docs",
      description: "Semantic search over the indexed codebase. Returns matching code chunks with file paths and line ranges.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, phrased like the code/docs you want" },
          k: { type: "integer", description: "Number of chunks to return (default 5)" },
        },
        required: ["query"],
      },
    },
    {
      name: "read_file",
      description: "Read a range of lines from a file in the repo. Use after search_docs to see full context.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path" },
          startLine: { type: "integer", description: "1-based start line (default 1)" },
          endLine: { type: "integer", description: "1-based inclusive end line (default start+199)" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description: "List indexed files, optionally filtered by path prefix. Useful to map the repo layout.",
      parameters: {
        type: "object",
        properties: { prefix: { type: "string", description: "Only paths starting with this prefix" } },
      },
    },
  ];
}

export type ToolExecutor = (call: ToolCall) => Promise<string>;

const MAX_TOOL_OUTPUT = 6_000;

export function createToolExecutor(repoRoot: string, store: VectorStore, embedder: Embedder): ToolExecutor {
  return async (call: ToolCall): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return `Error: malformed tool arguments for ${call.name}`;
    }
    const out =
      call.name === "search_docs" ? await searchDocs(store, embedder, args)
      : call.name === "read_file" ? await readFileRange(repoRoot, args)
      : call.name === "list_files" ? listFiles(store, args)
      : `Error: unknown tool "${call.name}"`;
    return out.length > MAX_TOOL_OUTPUT ? out.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : out;
  };
}

async function searchDocs(store: VectorStore, embedder: Embedder, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "");
  if (!query) return "Error: query is required";
  const k = Number(args.k ?? 5) || 5;
  const [vec] = await embedder.embed([query]);
  if (!vec) return "Error: embedding failed";
  const hits = store.search(vec, k);
  if (hits.length === 0) return "No matching chunks.";
  return hits
    .map(({ chunk, score }) => `### ${chunk.path}:${chunk.startLine}-${chunk.endLine} (score ${score.toFixed(3)})\n${chunk.text}`)
    .join("\n\n");
}

async function readFileRange(repoRoot: string, args: Record<string, unknown>): Promise<string> {
  const rel = String(args.path ?? "");
  if (!rel || isAbsolute(rel)) return "Error: path must be repo-relative";
  const full = resolve(repoRoot, rel);
  // Path confinement: never read outside the repo root.
  if (full !== resolve(repoRoot) && !full.startsWith(resolve(repoRoot) + "/")) {
    return "Error: path escapes repo root";
  }
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch {
    return `Error: cannot read ${rel}`;
  }
  const lines = text.split("\n");
  const start = Math.max(1, Number(args.startLine ?? 1) || 1);
  const end = Math.min(lines.length, Number(args.endLine ?? start + 199) || start + 199);
  const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)} | ${l}`).join("\n");
  return `${rel}:${start}-${end} (of ${lines.length} lines)\n${body}`;
}

function listFiles(store: VectorStore, args: Record<string, unknown>): string {
  const prefix = String(args.prefix ?? "");
  const files = store.files().filter((f) => f.startsWith(prefix)).slice(0, 300);
  return files.length === 0 ? `No indexed files under "${prefix}".` : `${files.length} file(s):\n${files.join("\n")}`;
}
