/** Offline smoke-test provider: returns a canned SQL answer, no network, no keys. */
import type { ChatProvider, ChatOptions } from "../providers.ts";
import type { Message, ToolSpec } from "../types.ts";

export const OFFLINE_DEMO_SQL = `SELECT COUNT(*) AS total_orders FROM orders`;

export class ScriptedSqlProvider implements ChatProvider {
  readonly name = "scripted-sql";
  calls = 0;

  async chat(messages: Message[], _tools: ToolSpec[], opts: ChatOptions = {}): Promise<{ text: string; toolCalls: never[] }> {
    this.calls++;
    opts.onToken?.("```sql\n");
    const text = "```sql\n" + OFFLINE_DEMO_SQL + "\n```";
    opts.onToken?.(OFFLINE_DEMO_SQL);
    return { text, toolCalls: [] as never[] };
  }
}
