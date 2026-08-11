import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseValue, setNestedValue } from "../src/cli/commands/config.js";
import { runResearchLoop } from "../src/agent/research-loop.js";
import { createSession, loadSession, saveSession } from "../src/memory/session.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type {
  AIProvider,
  NormalizedDelta,
  NormalizedMessage,
  ProviderStreamHandle,
} from "../src/providers/index.js";
import { ToolCache } from "../src/tools/cache.js";
import { resolveWorkspacePath } from "../src/tools/path-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { shellQuote } from "../src/hooks/runner.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("parses primitive values and sets dotted keys", () => {
    const target: Record<string, unknown> = { sandbox: { enabled: false } };
    setNestedValue(target, "sandbox.enabled", parseValue("true"));
    setNestedValue(target, "memory.topK", parseValue("12"));
    expect(target).toEqual({
      sandbox: { enabled: true },
      memory: { topK: 12 },
    });
  });
});

describe("workspace path guard", () => {
  it("allows workspace paths and rejects traversal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-path-"));
    try {
      expect(resolveWorkspacePath(root, "src/index.ts")).toBe(
        path.join(root, "src", "index.ts"),
      );
      expect(() => resolveWorkspacePath(root, "../secret.txt")).toThrow(
        /outside the active workspace/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("hook template escaping", () => {
  it("quotes shell metacharacters as one literal argument", () => {
    const quoted = shellQuote("a'; Write-Output HACK; '");
    if (process.platform === "win32") {
      expect(quoted).toBe("'a''; Write-Output HACK; '''");
    } else {
      expect(quoted).toBe("'a'\\''; Write-Output HACK; '\\'''");
    }
  });
});

describe("session persistence", () => {
  it("loads a saved session by an unambiguous id prefix", async () => {
    const session = createSession(process.cwd(), "test-model");
    session.messages.push({ role: "user", content: "hello" });
    await saveSession(session);
    const loaded = await loadSession(session.id.slice(0, 10));
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.messages).toEqual(session.messages);
  });
});

describe("tool cache lifetime", () => {
  it("can be shared by registries across turns", () => {
    const cache = new ToolCache();
    const first = new ToolRegistry(process.cwd(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, cache);
    const second = new ToolRegistry(process.cwd(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, cache);
    expect(first.cache).toBe(cache);
    expect(second.cache).toBe(cache);
  });
});

describe("OpenAI-compatible streaming errors", () => {
  it("rejects finalMessage when the HTTP request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("invalid key", { status: 401, statusText: "Unauthorized" })
    ));
    const provider = new OpenAICompatibleProvider(
      "https://example.invalid/v1",
      "bad-key",
      "openai",
    );
    const handle = provider.stream({
      model: "test",
      maxTokens: 1024,
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await expect(handle.finalMessage()).rejects.toThrow(/401/);
  });
});

describe("research loop result propagation", () => {
  it("extracts the summary from the updated agent history", async () => {
    const message: NormalizedMessage = {
      stop_reason: "end_turn",
      content: [{
        type: "text",
        text: "[[RESEARCH_COMPLETE]]\n## Summary\nVerified result",
      }],
      usage: { input_tokens: 1, output_tokens: 4 },
    };
    const provider: AIProvider = {
      providerName: "custom",
      stream(): ProviderStreamHandle {
        return {
          async *deltas(): AsyncIterable<NormalizedDelta> {
            yield { type: "text", text: "Verified result" };
          },
          async finalMessage() {
            return message;
          },
        };
      },
    };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "allycode-research-"));
    try {
      const result = await runResearchLoop({
        query: "test",
        provider,
        model: "test",
        maxTokens: 1024,
        searchConfig: {},
        cwd,
      });
      expect(result.summary).toContain("Verified result");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
