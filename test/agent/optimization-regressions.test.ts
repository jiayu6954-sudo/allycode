import { describe, expect, it } from "vitest";
import { advanceCompaction, createCompactionState, extractFacts, validateCompactionState } from "../../src/agent/context-compaction.js";
import { applyHistoryBudget } from "../../src/agent/history-budget.js";
import { enforceReasoningRetention } from "../../src/agent/loop.js";
import type { AIProvider } from "../../src/providers/interface.js";
import type { ConversationMessage } from "../../src/types/agent.js";

describe("long task regression contracts", () => {
  it("backs off failed summary calls while preserving facts, canonical history and later recovery", async () => {
    let attempts=0;
    const provider:AIProvider={providerName:"custom",stream:()=>{
      attempts++;
      if(attempts<3)throw new Error("temporary failure");
      return {async *deltas(){},async finalMessage(){return {stop_reason:"end_turn",content:[{type:"text",text:"恢复的摘要"}],usage:{input_tokens:10,output_tokens:2}};}};
    }};
    const history:ConversationMessage[]=Array.from({length:70},(_,i)=>({role:i%2?"assistant":"user",content:`message ${i}`}));
    const original=structuredClone(history);
    const state=createCompactionState();
    for(let i=0;i<8;i++)await advanceCompaction(state,history,40,provider,"mock");
    expect(attempts).toBe(1);expect(state.factsThrough).toBe(40);expect(state.summarisedThrough).toBe(0);
    await advanceCompaction(state,history,42,provider,"mock");
    expect(attempts).toBe(2);
    for(let end=43;end<46;end++)await advanceCompaction(state,history,end,provider,"mock");
    expect(attempts).toBe(2);expect(state.factsThrough).toBe(45);
    await advanceCompaction(state,history,46,provider,"mock");
    expect(attempts).toBe(3);expect(state.modelCalls).toBe(3);expect(state.narratives).toEqual(["恢复的摘要"]);
    expect(state.consecutiveFailures).toBe(0);expect(history).toEqual(original);
  });

  it("does not repeatedly bill empty summaries or inherit retry state across replaced history",async()=>{
    let attempts=0;
    const provider:AIProvider={providerName:"custom",stream:()=>({async *deltas(){},async finalMessage(){attempts++;return {stop_reason:"max_tokens",content:[],usage:{input_tokens:10,output_tokens:700}};}})};
    const history:ConversationMessage[]=Array.from({length:25},()=>({role:"user",content:"same"}));
    const state=createCompactionState();
    await advanceCompaction(state,history,20,provider,"mock");
    await advanceCompaction(state,history,20,provider,"mock");
    expect(attempts).toBe(1);expect(state.failures).toBe(1);
    validateCompactionState(state,[{role:"user",content:"new project"}]);
    expect(state.lastAttemptedThrough).toBe(0);expect(state.consecutiveFailures).toBe(0);
  });
  it("accumulates small drops before summarising and bounds the narrative", async () => {
    let calls = 0;
    const provider: AIProvider = { providerName: "custom", stream: () => ({
      async *deltas() {},
      async finalMessage() { calls++; return { stop_reason: "end_turn", content: [{ type: "text", text: "summary".repeat(2000) }], usage: { input_tokens: 10, output_tokens: 2 } }; },
    }) };
    const history: ConversationMessage[] = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));
    const state = createCompactionState();
    for (let end = 1; end <= 60; end++) await advanceCompaction(state, history, end, provider, "mock");
    expect(calls).toBe(3);
    expect(state.narratives.join("").length).toBeLessThanOrEqual(6000);
    expect(state.facts.toolCallCount).toBe(0);
  });

  it("does not silently submit a recent message exceeding the hard request budget", () => {
    expect(() => applyHistoryBudget([{ role: "user", content: "x".repeat(350000) }], { maxContextTokens: 8000 }))
      .toThrow(/context|上下文/i);
  });

  it("invalidates summaries when their canonical transcript is replaced", async () => {
    const state = createCompactionState();
    const provider = {stream: () => {throw new Error("no summary needed");}} as unknown as AIProvider;
    const original: ConversationMessage[] = [{role:"user",content:"original goal"}];
    await advanceCompaction(state, original, 1, provider, "mock");
    validateCompactionState(state, [...original, {role:"assistant",content:"new reply"}]);
    expect(state.factsThrough).toBe(1);
    validateCompactionState(state, [{role:"user",content:"different goal"}]);
    expect(state.factsThrough).toBe(0);
    expect(state.narratives).toEqual([]);
  });

  it("preserves a block-form initial goal and counts the summary in its budget", () => {
    const goal: ConversationMessage = { role: "user", content: [{ type: "text", text: "KEEP MY GOAL" }] };
    const history: ConversationMessage[] = [goal, ...Array.from({length: 80}, (_, i): ConversationMessage => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(600) }))];
    const result = applyHistoryBudget(history, { maxContextTokens: 1500, summaryMessages: [{ role: "user", content: "summary ".repeat(150) }] });
    expect(result.messages[0]).toEqual(goal);
    expect(result.after).toBeLessThanOrEqual(1500);
  });

  it("does not record failed or unanswered writes as successful facts", () => {
    const facts = extractFacts([
      { role: "assistant", content: [{ type: "tool_use", id: "bad", name: "file_write", input: { path: "missing.ts" } }, { type: "tool_use", id: "pending", name: "file_edit", input: { path: "pending.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "bad", content: "denied", is_error: true }] },
    ]);
    expect(facts.filesTouched).toEqual([]);
    expect(facts.errorCount).toBe(1);
  });

  it("retains provider continuation state after end_turn", () => {
    const messages: ConversationMessage[] = [{ role: "assistant", content: "done", providerState: { protocol: "deepseek-chat", reasoningContent: "synthetic-state" } }];
    enforceReasoningRetention(messages);
    expect(messages[0]?.providerState?.protocol === "deepseek-chat" && Boolean(messages[0].providerState.reasoningContent)).toBe(true);
  });
});
