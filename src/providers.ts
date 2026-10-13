import type { ChatResult, Message, ToolCall, ToolSpec } from "./types.ts";

/**
 * Provider-agnostic chat layer over the raw OpenAI and Anthropic REST APIs.
 * No SDKs — request shaping, SSE streaming, and tool-call normalization are
 * implemented here so the agent loop stays provider-neutral.
 */

export interface ChatOptions {
  model?: string;
  onToken?: (t: string) => void;
}

export interface ChatProvider {
  readonly name: string;
  chat(messages: Message[], tools: ToolSpec[], opts?: ChatOptions): Promise<ChatResult>;
}

/* ---------------------------------- OpenAI --------------------------------- */

export interface OpenAIAcc {
  text: string;
  calls: Map<number, { id: string; name: string; arguments: string }>;
}

/** Pure accumulator — feed it each parsed SSE JSON payload. */
export function accumulateOpenAI(acc: OpenAIAcc, payload: unknown): void {
  const p = payload as { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
  const delta = p.choices?.[0]?.delta;
  if (!delta) return;
  if (delta.content) acc.text += delta.content;
  for (const tc of delta.tool_calls ?? []) {
    const slot = acc.calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    acc.calls.set(tc.index, slot);
  }
}

export class OpenAIChat implements ChatProvider {
  readonly name = "openai";
  constructor(
    private apiKey: string,
    private model = process.env.ASKREPO_OPENAI_MODEL || "gpt-4o-mini",
  ) {}

  async chat(messages: Message[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: opts.model || this.model,
        stream: true,
        messages: messages.map(toOpenAIMessage),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const acc: OpenAIAcc = { text: "", calls: new Map() };
    for await (const payload of sseData(res.body)) {
      accumulateOpenAI(acc, payload);
      const p = payload as { choices?: { delta?: { content?: string } }[] };
      const t = p.choices?.[0]?.delta?.content;
      if (t) opts.onToken?.(t);
    }
    return { text: acc.text, toolCalls: [...acc.calls.values()] };
  }
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

/* --------------------------------- Anthropic -------------------------------- */

interface AnthropicBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  json: string;
}

export interface AnthropicAcc {
  text: string;
  blocks: Map<number, AnthropicBlock>;
}

/** Pure accumulator — feed it (eventName, parsedPayload). Null events are ignored. */
export function accumulateAnthropic(acc: AnthropicAcc, event: string | null, payload: unknown): void {
  if (!event) return;
  if (event === "content_block_start") {
    const p = payload as { index: number; content_block: { type: string; id?: string; name?: string } };
    acc.blocks.set(p.index, { type: p.content_block.type as AnthropicBlock["type"], id: p.content_block.id, name: p.content_block.name, json: "" });
  } else if (event === "content_block_delta") {
    const p = payload as { index: number; delta: { type: string; text?: string; partial_json?: string } };
    const block = acc.blocks.get(p.index);
    if (!block) return;
    if (p.delta.type === "text_delta" && p.delta.text) {
      block.text = (block.text ?? "") + p.delta.text;
      acc.text += p.delta.text;
    } else if (p.delta.type === "input_json_delta" && p.delta.partial_json) {
      block.json += p.delta.partial_json;
    }
  }
}

export class AnthropicChat implements ChatProvider {
  readonly name = "anthropic";
  constructor(
    private apiKey: string,
    private model = process.env.ASKREPO_ANTHROPIC_MODEL || "claude-sonnet-4-5",
  ) {}

  async chat(messages: Message[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model || this.model,
        max_tokens: 2048,
        stream: true,
        system,
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const acc: AnthropicAcc = { text: "", blocks: new Map() };
    for await (const { event, payload } of sseEventData(res.body)) {
      const before = acc.text;
      accumulateAnthropic(acc, event, payload);
      if (acc.text.length > before.length) opts.onToken?.(acc.text.slice(before.length));
    }
    const toolCalls: ToolCall[] = [...acc.blocks.values()]
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({ id: b.id!, name: b.name!, arguments: b.json || "{}" }));
    return { text: acc.text, toolCalls };
  }
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: safeJson(c.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] });
    }
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/* ----------------------------------- SSE ----------------------------------- */

/** Parse an SSE body stream into JSON payloads (OpenAI-style: data lines only). */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const { event, payload } of sseEventData(body)) {
    if (!event || event === "data" || event === "completion") yield payload;
  }
}

/** Parse an SSE body stream into { event, payload } pairs (Anthropic-style). */
async function* sseEventData(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; payload: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield { event, payload: JSON.parse(data) };
        } catch {
          // Ignore keepalives / non-JSON frames.
        }
      } else if (line === "") {
        event = null; // SSE events are separated by blank lines
      }
    }
  }
}
