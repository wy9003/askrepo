import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/chunk.ts";

test("small file becomes exactly one chunk with correct line range", () => {
  const text = ["line a", "line b", "line c"].join("\n");
  const chunks = chunkText(text, "a.txt");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks[0]!.endLine, 3);
  assert.ok(chunks[0]!.text.includes("line a"));
});

test("long file splits into chunks within size budget with overlap", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `// line ${i + 1} ${"x".repeat(30)}`);
  const chunks = chunkText(lines.join("\n"), "big.ts");
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= 1700, `chunk too large: ${c.text.length}`);
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
  }
  // Consecutive chunks overlap (next starts at or before previous end).
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i]!.startLine <= chunks[i - 1]!.endLine, "expected line overlap between consecutive chunks");
  }
  // Full coverage: first chunk starts at 1, last chunk ends at the last line.
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks[chunks.length - 1]!.endLine, 400);
});

test("blank-line boundaries produce chunks near target size", () => {
  const para = Array.from({ length: 10 }, (_, i) => `code line number ${i}`).join("\n");
  const text = Array.from({ length: 20 }, () => para).join("\n\n");
  const chunks = chunkText(text, "doc.md");
  assert.ok(chunks.length >= 2);
  // Boundary-flushed chunks sit near the target; only the final tail chunk may be small.
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.ok(chunks[i]!.text.length >= 400, `chunk ${i} suspiciously small (${chunks[i]!.text.length})`);
  }
});

test("empty and whitespace-only inputs produce no chunks", () => {
  assert.deepEqual(chunkText("", "e.txt"), []);
  assert.deepEqual(chunkText("\n\n\n", "e.txt"), []);
});
