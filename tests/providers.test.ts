import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateAnthropic, accumulateOpenAI } from "../src/providers.ts";

test("OpenAI accumulator assembles streamed text and split tool-call fragments", () => {
  const acc = { text: "", calls: new Map() };
  accumulateOpenAI(acc, { choices: [{ delta: { content: "Hel" } }] });
  accumulateOpenAI(acc, { choices: [{ delta: { content: "lo" } }] });
  assert.equal(acc.text, "Hello");

  // Tool call fragments arrive across deltas: id+name first, arguments split.
  accumulateOpenAI(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_docs", arguments: '{"qu' } }] } }] });
  accumulateOpenAI(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"auth"}' } }] } }] });
  const call = acc.calls.get(0)!;
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "search_docs");
  assert.deepEqual(JSON.parse(call.arguments), { query: "auth" });
});

test("Anthropic accumulator assembles text and tool_use blocks", () => {
  const acc = { text: "", blocks: new Map() };
  accumulateAnthropic(acc, "content_block_start", { index: 0, content_block: { type: "text" } });
  accumulateAnthropic(acc, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "Answ" } });
  accumulateAnthropic(acc, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "er" } });
  accumulateAnthropic(acc, "content_block_start", { index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } });
  accumulateAnthropic(acc, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"src/a' } });
  accumulateAnthropic(acc, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '.ts"}' } });

  assert.equal(acc.text, "Answer");
  const tool = acc.blocks.get(1)!;
  assert.equal(tool.id, "tu_1");
  assert.equal(tool.name, "read_file");
  assert.deepEqual(JSON.parse(tool.json), { path: "src/a.ts" });
});
