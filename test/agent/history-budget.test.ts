import { describe, expect, it } from "vitest";
import {
  applyHistoryBudget,
  estimateHistoryTokens,
  estimateTokens,
  repairBoundaries,
} from "../../src/agent/history-budget.js";
import type { ConversationMessage } from "../../src/types/agent.js";

function userText(text: string): ConversationMessage {
  return { role: "user", content: text };
}

function assistantToolCall(id: string, reasoning?: string): ConversationMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "bash", input: { command: "ls" } }],
    ...(reasoning
      ? { providerState: { protocol: "deepseek-chat" as const, reasoningContent: reasoning } }
      : {}),
  } as ConversationMessage;
}

function toolResult(id: string, body: string): ConversationMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: body, is_error: false }],
  } as ConversationMessage;
}

/** A transcript of `turns` tool round-trips, each carrying a large result. */
function transcript(turns: number, resultChars = 4_000): ConversationMessage[] {
  const messages: ConversationMessage[] = [userText("请从零交付这个项目")];
  for (let index = 0; index < turns; index++) {
    messages.push(assistantToolCall(`t${index}`, "思考".repeat(200)));
    messages.push(toolResult(`t${index}`, "X".repeat(resultChars)));
  }
  return messages;
}

/** Every tool_result must be answered by a preceding tool_use, and vice versa. */
function assertWellFormed(messages: ConversationMessage[]): void {
  const open = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") open.add(block.id);
      if (block.type === "tool_result") {
        expect(open.has(block.tool_use_id), `orphaned tool_result ${block.tool_use_id}`).toBe(true);
        open.delete(block.tool_use_id);
      }
    }
  }
  expect([...open], "unanswered tool_use at end of transcript").toEqual([]);
}

describe("history budget", () => {
  it("estimates CJK and Latin text differently", () => {
    expect(estimateTokens("中文测试")).toBe(4);
    expect(estimateTokens("hello world hi")).toBeLessThan(6);
    expect(estimateTokens("")).toBe(0);
  });

  it("leaves a small transcript untouched", () => {
    const messages = transcript(3, 100);
    const result = applyHistoryBudget(messages, { maxContextTokens: 100_000 });

    expect(result.messages).toBe(messages);
    expect(result.agedResults).toBe(0);
    expect(result.droppedMessages).toBe(0);
  });

  it("cuts a long transcript down to the budget", () => {
    const messages = transcript(60);
    const before = estimateHistoryTokens(messages);
    const result = applyHistoryBudget(messages, { maxContextTokens: 8_000 });

    expect(before).toBeGreaterThan(50_000);
    expect(result.after).toBeLessThan(before / 2);
    expect(result.after).toBeLessThanOrEqual(result.before);
  });

  it("ages old tool results but keeps recent ones intact", () => {
    const messages = transcript(40);
    const result = applyHistoryBudget(messages, {
      maxContextTokens: 20_000,
      keepRecentMessages: 10,
      agedToolResultChars: 200,
    });

    expect(result.agedResults).toBeGreaterThan(0);
    const last = result.messages.at(-1)!;
    // The newest result is still full size — recent context stays usable.
    const body = Array.isArray(last.content) && last.content[0]?.type === "tool_result"
      ? String(last.content[0].content)
      : "";
    expect(body.length).toBeGreaterThan(1_000);
  });

  it("never leaves an orphaned or unanswered tool call", () => {
    for (const turns of [12, 25, 40, 80]) {
      for (const budget of [3_000, 8_000, 20_000]) {
        const result = applyHistoryBudget(transcript(turns), {
          maxContextTokens: budget,
          keepRecentMessages: 20,
        });
        assertWellFormed(result.messages);
      }
    }
  });

  it("keeps the original request and marks what was dropped", () => {
    const result = applyHistoryBudget(transcript(60), { maxContextTokens: 5_000 });

    expect(result.messages[0]?.content).toBe("请从零交付这个项目");
    expect(result.droppedMessages).toBeGreaterThan(0);
    const marker = result.messages[1];
    expect(String(marker?.content)).toContain("历史消息已省略");
    // The model must be told to re-read rather than trust a faded memory.
    expect(String(marker?.content)).toContain("不要凭记忆假设");
  });

  it("counts DeepSeek thinking text as part of the resent cost", () => {
    const withThinking = [userText("go"), assistantToolCall("a", "推理".repeat(500)), toolResult("a", "ok")];
    const withoutThinking = [userText("go"), assistantToolCall("a"), toolResult("a", "ok")];

    expect(estimateHistoryTokens(withThinking))
      .toBeGreaterThan(estimateHistoryTokens(withoutThinking) + 900);
  });

  it("repairs both ends of a sliced transcript", () => {
    const orphanStart = repairBoundaries([toolResult("x", "result"), userText("hi")]);
    expect(orphanStart).toHaveLength(1);

    const danglingEnd = repairBoundaries([userText("hi"), assistantToolCall("y")]);
    expect(danglingEnd).toHaveLength(1);

    const intact = [userText("hi"), assistantToolCall("z"), toolResult("z", "ok")];
    expect(repairBoundaries(intact)).toHaveLength(3);
  });

  it("keeps shrinking rather than giving up when the window is tiny", () => {
    const result = applyHistoryBudget(transcript(50, 20_000), {
      maxContextTokens: 2_000,
      keepRecentMessages: 20,
    });

    assertWellFormed(result.messages);
    expect(result.messages.length).toBeLessThan(20);
    expect(result.after).toBeLessThan(result.before / 10);
  });
});
