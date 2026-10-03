/**
 * Agent Loop — Integration Tests
 *
 * Tests the full runAgentLoop() pipeline end-to-end using a scripted mock
 * provider. No real API keys required — the mock provider returns pre-crafted
 * responses that exercise the tool execution path.
 *
 * Gap this fills: previously the Agent Loop had zero automated test coverage.
 * These tests are the "分水岭" — the difference between a prototype and
 * software that can be confidently refactored.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runAgentLoop } from "../../src/agent/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import type { AIProvider } from "../../src/providers/index.js";
import type { ProviderStreamHandle, NormalizedMessage, NormalizedDelta } from "../../src/providers/interface.js";
import type { StreamParams } from "../../src/providers/interface.js";
import type { AgentEvent } from "../../src/types/agent.js";
import type { AllyCodeSettings } from "../../src/config/schema.js";
import { SettingsSchema } from "../../src/config/schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temp directory, cleaned up after each test */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "allycode-loop-test-"));
}

/** Minimal settings object — all permissions auto, no API keys needed */
function makeSettings(overrides: Partial<AllyCodeSettings> = {}): AllyCodeSettings {
  return SettingsSchema.parse({
    defaultPermissions: {
      bash: "deny",
      file_write: "auto",
      file_edit: "auto",
      file_read: "auto",
      glob: "auto",
      grep: "auto",
      web_fetch: "deny",
      web_search: "deny",
      git_commit: "deny",
      spawn_research: "deny",
    },
    ...overrides,
  });
}

/**
 * Mock stream handle — yields no deltas, resolves to the scripted message.
 */
function mockStream(message: NormalizedMessage): ProviderStreamHandle {
  return {
    async *deltas(): AsyncIterable<NormalizedDelta> {
      // Yield the text delta if present, so text_delta events fire
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text", text: block.text };
        }
      }
    },
    async finalMessage(): Promise<NormalizedMessage> {
      return message;
    },
  };
}

/**
 * Build a mock AIProvider from a sequence of scripted responses.
 * Each call to stream() consumes the next response in the queue.
 */
function mockProvider(responses: NormalizedMessage[]): AIProvider {
  let callIndex = 0;
  return {
    stream(_params: StreamParams): ProviderStreamHandle {
      const response = responses[callIndex];
      if (!response) throw new Error(`Mock provider: no response scripted for call #${callIndex + 1}`);
      callIndex++;
      return mockStream(response);
    },
  } as unknown as AIProvider;
}

/** Collect all events emitted during a loop run */
function collectEvents(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgentLoop — integration", () => {
  let tempDir: string;
  const toolTurn=(name:string,input:unknown,id:string):NormalizedMessage=>({stop_reason:"tool_use",content:[{type:"tool_use",name,input,id}],usage:{input_tokens:1,output_tokens:1}});
  const finalTurn=():NormalizedMessage=>({stop_reason:"end_turn",content:[{type:"text",text:"本轮结束"}],usage:{input_tokens:1,output_tokens:1}});

  it("closes unfinished plans once without rerunning tools, and pauses rather than inventing completion",async()=>{
    tempDir=await makeTempDir();
    const {onEvent,events}=collectEvents();
    const result=await runAgentLoop(mockProvider([toolTurn("plan_update",{items:[{step:"等待设备",status:"pending"}]},"plan"),finalTurn(),finalTurn()]),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[],onEvent,requirePlan:true},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false));
    expect(result.stopReason).toBe("checkpoint");
    expect(events.filter(event=>event.type==="tool_start").map(event=>event.type==="tool_start"&&event.toolName)).toEqual(["plan_update"]);
  });

  it("ends immediately after a durable phase checkpoint without another model call",async()=>{
    tempDir=await makeTempDir();await fs.writeFile(path.join(tempDir,"ARCHITECTURE.md"),"Design");
    const phase={kind:"decision",title:"选方案",summary:"目标",document:"ARCHITECTURE.md",nextSteps:["实现"],options:[{id:"A",title:"单体",tradeoff:"维护简单"},{id:"B",title:"服务化",tradeoff:"扩容灵活"}]};
    const {onEvent}=collectEvents();
    const result=await runAgentLoop(mockProvider([toolTurn("phase_checkpoint",phase,"phase")]),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[],onEvent},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false));
    expect(result.stopReason).toBe("checkpoint");expect(result.iterations).toBe(1);
    expect(JSON.stringify(result.updatedHistory)).toContain("收到明确选择后才进入实施");
    expect(result.updatedHistory.at(-2)?.role).toBe("user");
  });

  it("does not skip the decision boundary when steering arrives during the checkpoint tool",async()=>{
    tempDir=await makeTempDir();await fs.writeFile(path.join(tempDir,"ARCHITECTURE.md"),"Design");
    const phase={kind:"decision",title:"选方案",summary:"目标",document:"ARCHITECTURE.md",nextSteps:["实现"],options:[{id:"A",title:"本机",tradeoff:"简单"},{id:"B",title:"服务化",tradeoff:"可扩展"}]};
    const pending:Array<{id:string;text:string;createdAt:string}>=[];
    const result=await runAgentLoop(mockProvider([toolTurn("phase_checkpoint",phase,"phase")]),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[],readSteering:()=>pending,onEvent:event=>{if(event.type==="tool_start") pending.push({id:"new",text:"继续",createdAt:"now"});}},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false));
    expect(result.stopReason).toBe("checkpoint");expect(result.iterations).toBe(1);expect(pending).toHaveLength(1);
  });

  it("rejects mixed checkpoint and write batches before either operation runs",async()=>{
    tempDir=await makeTempDir();
    const mixed=toolTurn("phase_checkpoint",{},"phase");mixed.content.push({type:"tool_use",name:"file_write",id:"write",input:{path:"bad.txt",content:"bad"}});
    await runAgentLoop(mockProvider([mixed,finalTurn()]),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[],onEvent:()=>{}},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false));
    await expect(fs.stat(path.join(tempDir,"bad.txt"))).rejects.toThrow();
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists paired failed results before aborting consecutive errors", async () => {
    tempDir = await makeTempDir();
    const responses: NormalizedMessage[] = Array.from({length:5},(_,i)=>({stop_reason:"tool_use",content:[{type:"tool_use",id:`missing-${i}`,name:"file_read",input:{path:"missing-file.txt"}}],usage:{input_tokens:1,output_tokens:1}}));
    let saved: import("../../src/types/agent.js").ConversationMessage[] = [];
    await expect(runAgentLoop(mockProvider(responses),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[{role:"user",content:"read"}],onEvent:()=>{},onHistoryChange:(history)=>{saved=structuredClone(history);}},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false))).rejects.toThrow(/consecutive/);
    expect(saved).toHaveLength(11);
    expect(saved.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({type:"tool_result",tool_use_id:"missing-4",is_error:true})]));
  });

  it("does not report exhausted token budgets as completed", async () => {
    tempDir = await makeTempDir();
    const {events,onEvent}=collectEvents();
    await expect(runAgentLoop(mockProvider([]),{model:"mock",maxTokens:100,systemPrompt:"test",conversationHistory:[],onEvent,tokenBudget:{hardLimit:100,priorTokens:100}},new ToolRegistry(tempDir),new PermissionManager(makeSettings(),async()=>"allow",false))).rejects.toThrow(/budget exceeded/);
    expect(events.some(event=>event.type==="done")).toBe(false);
  });

  it("executes file_write tool and creates the file", async () => {
    tempDir = await makeTempDir();
    const targetFile = path.join(tempDir, "hello.py");

    // Turn 1: AI decides to write a file
    const turn1: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "I'll write a hello world Python file for you." },
        {
          type: "tool_use",
          id: "tool_001",
          name: "file_write",
          input: { path: targetFile, content: 'print("Hello, World!")\n' },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    // Turn 2: AI acknowledges the result and stops
    const turn2: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done! The file has been created." }],
      usage: { input_tokens: 150, output_tokens: 20 },
    };

    const settings = makeSettings();
    const tools = new ToolRegistry(tempDir);
    const permissions = new PermissionManager(settings, async () => "allow" as const, false);
    const { events, onEvent } = collectEvents();

    const result = await runAgentLoop(
      mockProvider([turn1, turn2]),
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [{ role: "user", content: "Write a hello world in Python." }],
        onEvent,
      },
      tools,
      permissions,
    );

    // File should exist with correct content
    const content = await fs.readFile(targetFile, "utf-8");
    expect(content).toBe('print("Hello, World!")\n');

    // Loop should have completed cleanly
    expect(result.finalMessage.stop_reason).toBe("end_turn");

    // Events should include tool_start, tool_result, and done
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("tool_start");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("done");

    const phases = events
      .filter((event): event is Extract<AgentEvent, { type: "status" }> => event.type === "status")
      .map((event) => event.phase);
    expect(phases).toContain("waiting_model");
    expect(phases).toContain("streaming");
    expect(phases).toContain("tool_running");
    expect(phases).toContain("waiting_model_after_tool");
    expect(phases.at(-1)).toBe("completed");
    expect(eventTypes.indexOf("tool_pending")).toBeLessThan(eventTypes.indexOf("tool_start"));
    expect(eventTypes.indexOf("tool_start")).toBeLessThan(eventTypes.indexOf("tool_result"));
    expect(eventTypes.indexOf("tool_result")).toBeLessThan(
      events.findIndex((event) => event.type === "status" && event.phase === "waiting_model_after_tool"),
    );

    // tool_result should not be an error
    const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(toolResult?.isError).toBe(false);
  });

  it("checkpoints a tool transaction only after the matching result exists", async () => {
    tempDir = await makeTempDir();
    const targetFile = path.join(tempDir, "atomic.txt");
    const snapshots: Array<import("../../src/types/agent.js").ConversationMessage[]> = [];
    const turn1: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool_atomic",
        name: "file_write",
        input: { path: targetFile, content: "atomic" },
      }],
      usage: { input_tokens: 10, output_tokens: 5 },
      providerState: {
        protocol: "deepseek-chat",
        reasoningContent: "must survive with the tool call",
      },
    };
    const turn2: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 20, output_tokens: 2 },
    };

    await runAgentLoop(
      mockProvider([turn1, turn2]),
      {
        model: "deepseek-v4-pro",
        maxTokens: 4096,
        systemPrompt: "test",
        conversationHistory: [{ role: "user", content: "write" }],
        onEvent: () => undefined,
        onHistoryChange: async (history) => { snapshots.push(structuredClone(history)); },
      },
      new ToolRegistry(tempDir),
      new PermissionManager(makeSettings(), async () => "allow", false),
    );

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.some((history) => {
      const last = history.at(-1);
      return last?.role === "assistant" && Array.isArray(last.content) &&
        last.content.some((block) => block.type === "tool_use");
    })).toBe(false);
    expect(snapshots[0]).toHaveLength(3);
    expect(snapshots[0]?.[1]).toMatchObject({
      providerState: {
        protocol: "deepseek-chat",
        reasoningContent: "must survive with the tool call",
      },
    });
    expect(snapshots[0]?.[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_atomic" }],
    });
  });

  it("publishes a structured working plan and continues the agent loop", async () => {
    tempDir = await makeTempDir();
    const turn1: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "plan_001",
        name: "plan_update",
        input: {
          explanation: "先检查再验证",
          items: [
            { step: "检查代码", status: "in_progress" },
            { step: "运行测试", status: "pending" },
          ],
        },
      }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const turn2: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "计划已开始执行。" }],
      usage: { input_tokens: 15, output_tokens: 4 },
    };
    const { events, onEvent } = collectEvents();

    await runAgentLoop(
      mockProvider([turn1, turn2]),
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "test",
        conversationHistory: [{ role: "user", content: "完成复杂任务" }],
        onEvent,
      },
      new ToolRegistry(tempDir),
      new PermissionManager(makeSettings(), async () => "allow", false),
    );

    const plan = events.find((event): event is Extract<AgentEvent, { type: "plan_update" }> =>
      event.type === "plan_update"
    );
    expect(plan?.items).toEqual([
      { step: "检查代码", status: "in_progress" },
      { step: "运行测试", status: "pending" },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("handles tool error gracefully — loop continues, AI receives error message", async () => {
    tempDir = await makeTempDir();

    // Turn 1: AI tries to write to a non-existent deep path (will succeed with mkdir -p, so use an invalid path)
    // Instead test with a bad tool input that fails Zod validation
    const turn1: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_002",
          name: "file_write",
          // Missing required 'content' field — Zod will reject this
          input: { path: path.join(tempDir, "test.txt") },
        },
      ],
      usage: { input_tokens: 80, output_tokens: 30 },
    };

    // Turn 2: AI responds to the error and stops
    const turn2: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I see the tool failed. Let me try a different approach." }],
      usage: { input_tokens: 120, output_tokens: 25 },
    };

    const settings = makeSettings();
    const tools = new ToolRegistry(tempDir);
    const permissions = new PermissionManager(settings, async () => "allow" as const, false);
    const { events, onEvent } = collectEvents();

    const result = await runAgentLoop(
      mockProvider([turn1, turn2]),
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [{ role: "user", content: "Write something." }],
        onEvent,
      },
      tools,
      permissions,
    );

    // Loop should complete (not throw)
    expect(result.finalMessage.stop_reason).toBe("end_turn");

    // tool_result should be an error (Zod validation failure)
    const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toMatch(/Invalid tool input/);
  });

  it("respects maxIterations — stops loop at the configured limit", async () => {
    tempDir = await makeTempDir();

    // Craft a response that always requests a tool, forcing infinite loop —
    // but we cap it at maxIterations=2
    const toolTurn: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_003",
          name: "file_read",
          input: { path: path.join(tempDir, "nonexistent.txt") },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    // Provide enough responses for the iterations + 1 extra that shouldn't be reached
    const settings = makeSettings();
    const tools = new ToolRegistry(tempDir);
    const permissions = new PermissionManager(settings, async () => "allow" as const, false);
    const { events, onEvent } = collectEvents();
    const systemPrompts: string[] = [];
    const provider = {
      stream(params: StreamParams): ProviderStreamHandle {
        systemPrompts.push(params.systemPrompt);
        return mockStream(toolTurn);
      },
    } as unknown as AIProvider;

    const result = await runAgentLoop(
      provider,
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [{ role: "user", content: "Read a file." }],
        onEvent,
        maxIterations: 2,
      },
      tools,
      permissions,
    );

    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterations).toBe(2);
    expect(systemPrompts[0]).toContain("Only 2 model turns remain");
    expect(systemPrompts[1]).toContain("Only 1 model turn remain");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      stopReason: "max_iterations",
    });
  });

  it("checkpoints before excess tools and preserves matched tool results for continuation", async () => {
    tempDir = await makeTempDir();
    const toolTurn: NormalizedMessage = {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "budgeted-tool",
        name: "file_read",
        input: { path: path.join(tempDir, "never-read.txt") },
      }],
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const settings = makeSettings();
    const tools = new ToolRegistry(tempDir);
    const permissions = new PermissionManager(settings, async () => "allow" as const, false);
    const { events, onEvent } = collectEvents();

    await expect(runAgentLoop(
      mockProvider([toolTurn]),
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "test",
        conversationHistory: [{ role: "user", content: "read" }],
        onEvent,
        toolBudget: { hardLimit: 1, priorToolCalls: 1 },
      },
      tools,
      permissions,
    )).resolves.toMatchObject({stopReason:"tool_budget",updatedHistory:expect.arrayContaining([
      expect.objectContaining({role:"user",content:expect.arrayContaining([expect.objectContaining({type:"tool_result",tool_use_id:"budgeted-tool",is_error:true})])}),
    ])});
    expect(events.some((event) => event.type === "tool_start")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("detects [[CHECKPOINT]] marker and emits checkpoint event", async () => {
    tempDir = await makeTempDir();

    // AI responds with a CHECKPOINT marker
    const turn1: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "I've analyzed the requirements. [[CHECKPOINT: Please review the plan before I proceed.]]" },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    };

    const settings = makeSettings();
    const tools = new ToolRegistry(tempDir);
    const permissions = new PermissionManager(settings, async () => "allow" as const, false);
    const { events, onEvent } = collectEvents();

    await runAgentLoop(
      mockProvider([turn1]),
      {
        model: "mock-model",
        maxTokens: 4096,
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [{ role: "user", content: "Analyze this project." }],
        onEvent,
      },
      tools,
      permissions,
    );

    // Should emit a checkpoint event
    const checkpointEvent = events.find((e) => e.type === "checkpoint") as Extract<AgentEvent, { type: "checkpoint" }>;
    expect(checkpointEvent).toBeDefined();
    expect(checkpointEvent?.message).toBe("Please review the plan before I proceed.");

    // done event should have stopReason === "checkpoint"
    const doneEvent = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    expect(doneEvent?.stopReason).toBe("checkpoint");
  });
});
