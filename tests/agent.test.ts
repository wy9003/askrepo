import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";
import type { ChatProvider, ChatOptions } from "../src/providers.ts";
import type { ChatResult, Message, ToolCall, ToolSpec } from "../src/types.ts";

/** Provider that plays a scripted conversation: one tool call, then an answer. */
class ScriptedProvider implements ChatProvider {
  readonly name = "scripted";
  turns = 0;
  seenMessages: Message[] = [];

  constructor(private script: ChatResult[]) {}

  async chat(messages: Message[], _tools: ToolSpec[], _opts?: ChatOptions): Promise<ChatResult> {
    this.seenMessages = messages;
    const turn = this.script[this.turns] ?? { text: "fallback", toolCalls: [] };
    this.turns++;
    return turn;
  }
}

const toolCall: ToolCall = { id: "c1", name: "search_docs", arguments: '{"query":"auth"}' };

test("agent executes tool calls then returns the final answer", async () => {
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [toolCall] },
    { text: "Auth lives in src/auth.ts:10-42.", toolCalls: [] },
  ]);
  const calls: string[] = [];
  const run = await runAgent(provider, async (c) => {
    calls.push(c.name);
    return "### src/auth.ts:10-42\nfunction login() {}";
  }, "Where is auth handled?");

  assert.equal(run.answer, "Auth lives in src/auth.ts:10-42.");
  assert.deepEqual(calls, ["search_docs"]);
  assert.equal(run.toolCalls, 1);
  assert.equal(run.steps, 2);

  // Conversation shape: system, user, assistant+toolCalls, tool result.
  const m = provider.seenMessages;
  assert.equal(m[0]!.role, "system");
  assert.equal(m[1]!.role, "user");
  assert.equal(m[2]!.role, "assistant");
  assert.equal(m[3]!.role, "tool");
});

test("agent stops at the step budget instead of looping forever", async () => {
  const looping = new ScriptedProvider(Array.from({ length: 50 }, () => ({ text: "", toolCalls: [toolCall] })));
  const run = await runAgent(looping, async () => "result", "q", { maxSteps: 3 });
  assert.equal(run.steps, 3);
  assert.equal(run.toolCalls, 3);
  assert.ok(run.answer.includes("step budget"));
});

test("agent answers directly when no tool is needed", async () => {
  const provider = new ScriptedProvider([{ text: "Direct answer.", toolCalls: [] }]);
  const run = await runAgent(provider, async () => "unused", "q");
  assert.equal(run.answer, "Direct answer.");
  assert.equal(run.toolCalls, 0);
});
