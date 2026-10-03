import { describe, expect, it } from "vitest";
import { addUsage, consumedTokens, meteredProvider, withModelAccounting } from "../../src/providers/model-gateway.js";
import type { AIProvider, StreamParams } from "../../src/providers/interface.js";
import type { AgentEvent, AgentLoopOptions } from "../../src/types/agent.js";
import { ProviderFailure } from "../../src/providers/failure-diagnostics.js";

const params: StreamParams = { model: "deepseek-flash", maxTokens: 10, systemPrompt: "test", messages: [{role:"user",content:"test"}], tools: [] };
function provider(reported = true): AIProvider { return {providerName:"deepseek",stream:()=>({async *deltas(){},async finalMessage(){return {stop_reason:"end_turn",content:[{type:"text",text:"ok"}],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:100,reported}};}})}; }
const options = (events: AgentEvent[], limit=10000): AgentLoopOptions => ({ model: params.model, maxTokens: 10, systemPrompt: "", conversationHistory: [], onEvent:event=>events.push(event), tokenBudget:{warningThreshold:80,priorTokens:0,hardLimit:limit} });

describe("shared model accounting",()=>{
  it("preserves reported usage even when a reasoning-only response cannot finalize, without private text",async()=>{
    const events:AgentEvent[]=[];
    const broken:AIProvider={providerName:"deepseek",stream:()=>({async *deltas(){},async finalMessage(){throw new ProviderFailure("PRIVATE-body",{code:"reasoning_only_limit",finishReason:"length",hasReasoning:true,usageReported:true},{reported:true,input_tokens:10,output_tokens:700});}})};
    await withModelAccounting(options(events),async totals=>{
      await expect(meteredProvider(broken).stream({...params,purpose:"compaction"}).finalMessage()).rejects.toThrow("PRIVATE-body");
      expect(totals.outputTokens).toBe(700);expect(totals.unknownCalls).toBe(0);
    });
    const last=events.filter(event=>event.type==="model_call").at(-1);
    expect(last?.type==="model_call"&&last.record).toMatchObject({status:"reported",failureKind:"finalization_error",diagnostic:{code:"reasoning_only_limit"}});
    expect(JSON.stringify(events)).not.toContain("PRIVATE-body");
  });
  it("records a safe failure category without saving provider errors or treating them as free",async()=>{
    const events:AgentEvent[]=[];
    await withModelAccounting(options(events),async totals=>{
      const broken:AIProvider={providerName:"deepseek",stream:()=>{throw new Error("private-provider-error");}};
      expect(()=>meteredProvider(broken).stream(params)).toThrow();
      await meteredProvider(provider(false)).stream(params).finalMessage();
      expect(totals.estimatedCost).toBeNull();expect(totals.unknownCalls).toBe(2);
    });
    const failed=events.filter(event=>event.type==="model_call"&&event.record.status==="unknown");
    expect(failed.map(event=>event.type==="model_call"?event.record.failureKind:"")).toEqual(["request_error","missing_usage"]);
    expect(JSON.stringify(events)).not.toContain("private-provider-error");
  });
  it("settles main and auxiliary calls exactly once including cached input",async()=>{
    const events:AgentEvent[]=[];
    await withModelAccounting(options(events),async totals=>{
      const model=meteredProvider(provider());
      const main=model.stream(params); await main.finalMessage(); await main.finalMessage();
      await model.stream({...params,purpose:"compaction"}).finalMessage();
      await withModelAccounting(options([]),async child=>{
        expect(child).toBe(totals);
        await model.stream({...params,purpose:"research"}).finalMessage();
      });
      expect(consumedTokens(totals)).toBe(345);
      expect(totals.cacheReadTokens).toBe(300);
      expect(totals.estimatedCost).toBeGreaterThan(0);
    });
    expect(events.filter(event=>event.type==="usage")).toHaveLength(3);
    expect(events.filter(event=>event.type==="model_call" && event.record.status==="reported")).toHaveLength(3);
  });
  it("does not count missing usage as free and carries a conservative reservation",async()=>{
    await withModelAccounting(options([]),async totals=>{
      await meteredProvider(provider(false)).stream(params).finalMessage();
      expect(totals.unknownCalls).toBe(1);
      expect(totals.estimatedCost).toBeNull();
      expect(consumedTokens(totals)).toBeGreaterThan(500);
    });
  });
  it("reserves requests before concurrent calls can overspend",async()=>{
    await withModelAccounting(options([],700),async()=>{
      const model=meteredProvider(provider());
      const first=model.stream(params);
      expect(()=>model.stream(params)).toThrow(/budget/i);
      await first.finalMessage();
    });
  });
  it("preserves historical model prices and mixed currency uncertainty",()=>{
    const previous={inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,estimatedCost:3,costCurrency:"CNY" as const};
    const next={...previous,estimatedCost:5};
    expect(addUsage(previous,next).estimatedCost).toBe(8);
    expect(addUsage(previous,{...next,costCurrency:"USD"}).estimatedCost).toBeNull();
  });
});
