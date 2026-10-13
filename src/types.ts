/** Shared types for the askrepo pipeline. */

export interface Chunk {
  /** Repo-relative path, e.g. "src/agent.ts" */
  path: string;
  /** 1-based inclusive line range of this chunk in the original file. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** Normalized tool call, provider-agnostic. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments; parsed by the executor. */
  arguments: string;
}

/** One turn of the conversation, normalized. */
export type Message =
  | { role: "system" | "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatResult {
  /** Final or intermediate assistant text (may be empty when only tool calls). */
  text: string;
  toolCalls: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
