import type { Chunk } from "./types.ts";

/**
 * Line-based chunker with overlap.
 *
 * Files are split on logical boundaries first, size second: we accumulate
 * whole blocks (groups of lines separated by blank lines) until the buffer
 * reaches the target size, then emit it and carry the last few lines into
 * the next chunk so cross-boundary context survives retrieval.
 */

const TARGET_CHARS = 1200; // ~300 tokens of code
const MAX_CHARS = 1600;
const OVERLAP_LINES = 6;

export function chunkText(text: string, path: string): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];

  let buffer: string[] = [];
  let bufferStart = 1; // 1-based line number of buffer[0]

  const flush = () => {
    // Trim trailing blank lines so chunks never end on empty context.
    while (buffer.length > 0 && buffer[buffer.length - 1]!.trim() === "") buffer.pop();
    if (buffer.length === 0) return;

    const endLine = bufferStart + buffer.length - 1;
    chunks.push({ path, startLine: bufferStart, endLine, text: buffer.join("\n") });

    // Carry the tail lines as overlap into the next buffer.
    const tail = buffer.slice(-OVERLAP_LINES);
    buffer = [...tail];
    bufferStart = endLine - tail.length + 1;
  };

  for (const line of lines) {
    buffer.push(line);
    const size = buffer.join("\n").length;
    const atBoundary = line.trim() === "" && size >= TARGET_CHARS * 0.5;
    if (size >= MAX_CHARS || atBoundary) flush();
  }
  flush();

  return chunks.filter((c) => c.text.trim().length > 0);
}
