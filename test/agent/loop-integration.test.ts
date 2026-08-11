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

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
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

    // Loop throws after maxIterations — catch it
    await expect(
      runAgentLoop(
        mockProvider([toolTurn, toolTurn, toolTurn]),
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
      )
    ).rejects.toThrow(/exceeded 2 iterations/);

    // Should also have emitted an error event before throwing
    const errorEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(errorEvent?.error.message).toMatch(/exceeded 2 iterations/);
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
