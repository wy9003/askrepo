import type { ChatProvider } from "./providers.ts";
import type { ToolExecutor } from "./tools.ts";
import { buildToolSpecs } from "./tools.ts";
import type { Message } from "./types.ts";

export interface AgentEvents {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
  onToken?: (t: string) => void;
  onStep?: (step: number) => void;
}

export interface AgentRun {
  answer: string;
  steps: number;
  toolCalls: number;
}

const SYSTEM_PROMPT = `You are a senior engineer answering questions about a specific codebase.

Rules:
- Always ground answers in the repo. Use search_docs to find relevant chunks and read_file to confirm details.
- Cite evidence inline as path:startLine-endLine.
- If the repo does not contain the answer, say so plainly — never invent code or APIs.
- Prefer concise, structured answers: short paragraphs, bullets for lists.
- You may call multiple tools; stop searching once you have enough evidence.`;

/**
 * The agent loop: chat → tool calls → results → chat, until a plain answer
 * or the step budget is exhausted. Provider- and embedder-agnostic.
 */
export async function runAgent(
  provider: ChatProvider,
  executeTool: ToolExecutor,
  question: string,
  opts: { maxSteps?: number; events?: AgentEvents } = {},
): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 8;
  const events = opts.events ?? {};
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  let toolCallCount = 0;
  for (let step = 1; step <= maxSteps; step++) {
    events.onStep?.(step);
    const result = await provider.chat(messages, buildToolSpecs(), { onToken: events.onToken });

    if (result.toolCalls.length === 0) {
      return { answer: result.text, steps: step, toolCalls: toolCallCount };
    }

    messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      events.onToolCall?.(call.name, call.arguments);
      const out = await executeTool(call);
      events.onToolResult?.(call.name, out);
      messages.push({ role: "tool", toolCallId: call.id, content: out });
      toolCallCount++;
    }
  }

  return {
    answer: "Reached the tool-step budget before producing a final answer. Try raising --max-steps.",
    steps: maxSteps,
    toolCalls: toolCallCount,
  };
}
