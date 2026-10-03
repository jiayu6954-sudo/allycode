import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import { ResponsesProvider } from "../../src/providers/responses.js";
import type { ProviderStreamHandle } from "../../src/providers/interface.js";
import type { ConversationMessage } from "../../src/types/agent.js";
import type { ToolDefinition } from "../../src/types/tools.js";

const READ_TOOL: ToolDefinition = {
  name: "file_read",
  description: "Read a project file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("classifies reasoning-only output limits and preserves usage without exposing reasoning in diagnostics",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(sseResponse([
    {choices:[{delta:{reasoning_content:"PRIVATE_REASONING_FIXTURE"},finish_reason:"length"}],usage:{prompt_tokens:100,completion_tokens:700,prompt_cache_hit_tokens:40}},"[DONE]",
  ])));
  const provider=new OpenAICompatibleProvider("https://fixture.invalid","fixture-key","deepseek");
  const handle=provider.stream({model:"deepseek-flash",purpose:"compaction",maxTokens:700,systemPrompt:"Summarise",messages:[{role:"user",content:"fixture"}],tools:[]});
  await consume(handle);
  try {await handle.finalMessage();throw new Error("expected failure");}
  catch(error){
    expect(error).toMatchObject({diagnostic:{code:"reasoning_only_limit",finishReason:"length",hasReasoning:true,usageReported:true},reportedUsage:{input_tokens:60,output_tokens:700,cache_read_input_tokens:40}});
    expect(JSON.stringify(error)).not.toContain("PRIVATE_REASONING_FIXTURE");
  }
});

async function consume(handle: ProviderStreamHandle): Promise<string[]> {
  const deltas: string[] = [];
  for await (const delta of handle.deltas()) {
    deltas.push(`${delta.type}:${delta.text}`);
  }
  return deltas;
}

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => event === "[DONE]"
      ? "data: [DONE]\n\n"
      : `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetchQueue(responses: Response[], captured: CapturedRequest[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra fetch request");
    return response;
  }));
}

describe("DeepSeek Chat Completions continuation", () => {
  it("round-trips reasoning_content with fragmented tool calls without leaking providerState", async () => {
    const captured: CapturedRequest[] = [];
    installFetchQueue([
      sseResponse([
        {
          choices: [{
            delta: { reasoning_content: "先检查" },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            delta: {
              reasoning_content: "项目文件。",
              tool_calls: [{
                index: 0,
                id: "call_deepseek_1",
                function: { name: "file_", arguments: "{\"path\":\"READ" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { name: "read", arguments: "ME.md\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        },
        "[DONE]",
      ]),
      sseResponse([
        {
          choices: [{
            delta: { content: "工具结果已确认。" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 140, completion_tokens: 8 },
        },
        "[DONE]",
      ]),
    ], captured);

    const provider = new OpenAICompatibleProvider(
      "https://api.deepseek.com/v1",
      "test-key",
      "deepseek",
      undefined,
      "max_tokens",
      { reasoningMode: "enabled", reasoningEffort: "max" },
    );
    const initial: ConversationMessage[] = [
      { role: "user", content: "读取 README.md" },
    ];

    const firstHandle = provider.stream({
      model: "DeepSeek-V4-Pro",
      maxTokens: 32_000,
      systemPrompt: "You are AllyCode.",
      messages: initial,
      tools: [READ_TOOL],
    });
    await expect(consume(firstHandle)).resolves.toEqual([
      "thinking:先检查",
      "thinking:项目文件。",
    ]);
    const first = await firstHandle.finalMessage();

    expect(first.stop_reason).toBe("tool_use");
    expect(first.content).toEqual([{
      type: "tool_use",
      id: "call_deepseek_1",
      name: "file_read",
      input: { path: "README.md" },
    }]);
    expect(first.providerState).toEqual({
      protocol: "deepseek-chat",
      scope: {
        provider: "deepseek",
        protocol: "chat_completions",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/v1",
      },
      reasoningContent: "先检查项目文件。",
    });
    expect(first.usage).toMatchObject({
      input_tokens: 60,
      output_tokens: 20,
      cache_read_input_tokens: 40,
    });

    const history: ConversationMessage[] = [
      ...initial,
      {
        role: "assistant",
        content: first.content,
        providerState: first.providerState,
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_deepseek_1",
          content: "# AllyCode",
        }],
      },
    ];
    const secondHandle = provider.stream({
      model: "DeepSeek-V4-Pro",
      maxTokens: 32_000,
      systemPrompt: "You are AllyCode.",
      messages: history,
      tools: [READ_TOOL],
    });
    await consume(secondHandle);
    const second = await secondHandle.finalMessage();

    expect(second.content).toEqual([{ type: "text", text: "工具结果已确认。" }]);
    expect(captured).toHaveLength(2);
    expect(captured.every((request) => request.url.endsWith("/chat/completions"))).toBe(true);
    expect(captured[0]!.body).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });

    const secondMessages = captured[1]!.body["messages"] as Array<Record<string, unknown>>;
    expect(secondMessages).toHaveLength(4);
    expect(secondMessages[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "先检查项目文件。",
      tool_calls: [{
        id: "call_deepseek_1",
        type: "function",
        function: { name: "file_read", arguments: "{\"path\":\"README.md\"}" },
      }],
    });
    expect(secondMessages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_deepseek_1",
      content: "# AllyCode",
    });
    expect(JSON.stringify(captured[1]!.body)).not.toContain("providerState");
    expect(JSON.stringify(captured[1]!.body)).not.toContain("deepseek-chat");
  });

  it("does not replay DeepSeek reasoning state into a different model", async () => {
    const captured: CapturedRequest[] = [];
    installFetchQueue([sseResponse([{
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }, "[DONE]"])], captured);
    const provider = new OpenAICompatibleProvider(
      "https://api.deepseek.com/v1",
      "test-key",
      "deepseek",
    );
    const handle = provider.stream({
      model: "deepseek-v4-flash",
      maxTokens: 32,
      systemPrompt: "test",
      messages: [{
        role: "assistant",
        providerState: {
          protocol: "deepseek-chat",
          scope: {
            provider: "deepseek",
            protocol: "chat_completions",
            model: "deepseek-v4-pro",
            baseUrl: "https://api.deepseek.com/v1",
          },
          reasoningContent: "private-pro-state",
        },
        content: [{ type: "text", text: "previous answer" }],
      }],
      tools: [],
    });
    await consume(handle);
    await handle.finalMessage();
    expect(JSON.stringify(captured[0]!.body)).not.toContain("private-pro-state");
    expect(JSON.stringify(captured[0]!.body)).not.toContain("reasoning_content");
  });
});

describe("Kimi K3 Chat Completions continuation", () => {
  it("normalizes K3, preserves reasoning, and reports automatic cache usage", async () => {
    const captured: CapturedRequest[] = [];
    installFetchQueue([
      sseResponse([
        { choices: [{ delta: { reasoning_content: "先读取。" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_kimi_1", function: { name: "file_read", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 400, completion_tokens: 20, cached_tokens: 300 } },
        "[DONE]",
      ]),
      sseResponse([
        { choices: [{ delta: { content: "已读取。" }, finish_reason: "stop" }], usage: { prompt_tokens: 420, completion_tokens: 8, cached_tokens: 320 } },
        "[DONE]",
      ]),
    ], captured);

    const provider = new OpenAICompatibleProvider(
      "https://api.moonshot.cn/v1",
      "test-key",
      "moonshot",
      undefined,
      "max_completion_tokens",
      { reasoningEffort: "max" },
    );
    const firstHandle = provider.stream({
      model: "Kimi-k3",
      maxTokens: 131_072,
      systemPrompt: "You are AllyCode.",
      messages: [{ role: "user", content: "读取项目" }],
      tools: [READ_TOOL],
    });
    await consume(firstHandle);
    const first = await firstHandle.finalMessage();

    expect(first.usage).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 300 });
    expect(first.providerState).toMatchObject({
      protocol: "deepseek-chat",
      scope: { provider: "moonshot", model: "kimi-k3" },
      reasoningContent: "先读取。",
    });
    expect(captured[0]!.body).toMatchObject({
      model: "kimi-k3",
      max_completion_tokens: 131_072,
      reasoning_effort: "max",
    });
    expect(captured[0]!.body).not.toHaveProperty("max_tokens");

    const secondHandle = provider.stream({
      model: "kimi-k3",
      maxTokens: 131_072,
      systemPrompt: "You are AllyCode.",
      messages: [
        { role: "user", content: "读取项目" },
        { role: "assistant", content: first.content, providerState: first.providerState },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_kimi_1", content: "# Project" }] },
      ],
      tools: [READ_TOOL],
    });
    await consume(secondHandle);
    await secondHandle.finalMessage();
    const messages = captured[1]!.body["messages"] as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({ role: "assistant", reasoning_content: "先读取。" });
  });
});

describe("DeepSeek thinking history cost", () => {
  it("returns every retained assistant state under the current tools contract", async () => {
    // Official tools contract checked 2026-09-15: preserve all retained turns.
    const captured: CapturedRequest[] = [];
    installFetchQueue([
      sseResponse([
        { choices: [{ delta: { reasoning_content: "第一轮思考" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "file_read", arguments: "{\"path\":\"a.ts\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        "[DONE]",
      ]),
      sseResponse([
        { choices: [{ delta: { content: "完成。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        "[DONE]",
      ]),
    ], captured);

    const provider = new OpenAICompatibleProvider(
      "https://api.deepseek.com/v1",
      "test-key",
      "deepseek",
    );

    // Take an authentic providerState from a real round trip; a hand-built
    // scope would not satisfy the provider/protocol/model/baseUrl match.
    const firstHandle = provider.stream({
      model: "deepseek-v4-pro",
      maxTokens: 4_096,
      systemPrompt: "You are AllyCode.",
      messages: [{ role: "user", content: "开始" }],
      tools: [READ_TOOL],
    });
    await consume(firstHandle);
    const first = await firstHandle.finalMessage();

    const turn = (id: string, reasoning: string): ConversationMessage[] => [
      {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "file_read", input: { path: "a.ts" } }],
        providerState: { ...first.providerState!, reasoningContent: reasoning },
      } as ConversationMessage,
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } as ConversationMessage,
    ];

    const handle = provider.stream({
      model: "deepseek-v4-pro",
      maxTokens: 4_096,
      systemPrompt: "You are AllyCode.",
      messages: [
        { role: "user", content: "开始" },
        ...turn("call_1", "第一轮的很长的思考内容"),
        ...turn("call_2", "第二轮的很长的思考内容"),
        ...turn("call_3", "最近一轮的思考内容"),
        { role: "assistant", content: "完成", providerState: { ...first.providerState!, reasoningContent: "final-state" } } as ConversationMessage,
        { role: "user", content: "继续检查" },
      ],
      tools: [READ_TOOL],
    });
    await consume(handle);
    await handle.finalMessage();

    const wire = JSON.stringify(captured[1]!.body);
    expect(wire).toContain("第一轮的很长的思考内容");
    expect(wire).toContain("第二轮的很长的思考内容");
    // The turn actually being continued still carries its thinking, as required.
    expect(wire).toContain("最近一轮的思考内容");

    const messages = captured[1]!.body["messages"] as Array<Record<string, unknown>>;
    const withReasoning = messages.filter((message) => "reasoning_content" in message);
    expect(withReasoning).toHaveLength(4);
  });
});

describe("OpenAI Responses continuation", () => {
  it("round-trips raw output items and function_call_output in stateless mode", async () => {
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "encrypted-reasoning-state",
      summary: [{ type: "summary_text", text: "Inspect the file" }],
    };
    const functionItem = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_responses_1",
      name: "file_read",
      arguments: "{\"path\":\"README.md\"}",
      status: "completed",
    };
    const captured: CapturedRequest[] = [];
    installFetchQueue([
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "Inspect the file" },
        { type: "response.output_item.done", item: reasoningItem },
        { type: "response.output_item.done", item: functionItem },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            output: [reasoningItem, functionItem],
            usage: {
              input_tokens: 90,
              output_tokens: 16,
              input_tokens_details: { cached_tokens: 30 },
            },
          },
        },
      ]),
      sseResponse([
        { type: "response.output_text.delta", delta: "工具结果已确认。" },
        {
          type: "response.completed",
          response: {
            id: "resp_2",
            status: "completed",
            output: [{
              id: "msg_2",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "工具结果已确认。" }],
            }],
            usage: { input_tokens: 120, output_tokens: 9 },
          },
        },
      ]),
    ], captured);

    const provider = new ResponsesProvider(
      "https://api.openai.com/v1",
      "test-key",
      "openai",
      { reasoningEffort: "high" },
    );
    const initial: ConversationMessage[] = [
      { role: "user", content: "读取 README.md" },
    ];
    const firstHandle = provider.stream({
      model: "test-responses-model",
      maxTokens: 8_192,
      systemPrompt: "You are AllyCode.",
      messages: initial,
      tools: [READ_TOOL],
    });
    await expect(consume(firstHandle)).resolves.toEqual([
      "thinking:Inspect the file",
    ]);
    const first = await firstHandle.finalMessage();

    expect(first.stop_reason).toBe("tool_use");
    expect(first.content).toEqual([{
      type: "tool_use",
      id: "call_responses_1",
      name: "file_read",
      input: { path: "README.md" },
    }]);
    expect(first.providerState).toEqual({
      protocol: "responses",
      scope: {
        provider: "openai",
        protocol: "responses",
        model: "test-responses-model",
        baseUrl: "https://api.openai.com/v1",
      },
      responseId: "resp_1",
      outputItems: [reasoningItem, functionItem],
    });
    expect(first.usage).toMatchObject({
      input_tokens: 60,
      output_tokens: 16,
      cache_read_input_tokens: 30,
    });

    const history: ConversationMessage[] = [
      ...initial,
      {
        role: "assistant",
        content: first.content,
        providerState: first.providerState,
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_responses_1",
          content: "# AllyCode",
        }],
      },
    ];
    const secondHandle = provider.stream({
      model: "test-responses-model",
      maxTokens: 8_192,
      systemPrompt: "You are AllyCode.",
      messages: history,
      tools: [READ_TOOL],
    });
    await consume(secondHandle);
    const second = await secondHandle.finalMessage();

    expect(second.content).toEqual([{ type: "text", text: "工具结果已确认。" }]);
    expect(captured).toHaveLength(2);
    expect(captured.every((request) => request.url.endsWith("/responses"))).toBe(true);
    expect(captured[0]!.body).toMatchObject({
      store: false,
      reasoning: { effort: "high" },
      instructions: "You are AllyCode.",
    });
    expect(captured[0]!.body).not.toHaveProperty("previous_response_id");

    expect(captured[1]!.body["input"]).toEqual([
      { role: "user", content: "读取 README.md" },
      reasoningItem,
      functionItem,
      {
        type: "function_call_output",
        call_id: "call_responses_1",
        output: "# AllyCode",
      },
    ]);
    expect(captured[1]!.body["store"]).toBe(false);
    expect(captured[1]!.body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(captured[1]!.body)).not.toContain("providerState");
    expect(JSON.stringify(captured[1]!.body)).not.toContain("responseId");
  });

  it("does not replay Responses state into a different endpoint", async () => {
    const captured: CapturedRequest[] = [];
    installFetchQueue([sseResponse([{
      type: "response.completed",
      response: {
        id: "resp_new",
        status: "completed",
        output: [{
          id: "msg_new",
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 4, output_tokens: 1 },
      },
    }])], captured);
    const provider = new ResponsesProvider(
      "https://gateway.example/v1",
      "test-key",
      "custom",
    );
    const handle = provider.stream({
      model: "same-model",
      maxTokens: 32,
      systemPrompt: "test",
      messages: [{
        role: "assistant",
        providerState: {
          protocol: "responses",
          scope: {
            provider: "custom",
            protocol: "responses",
            model: "same-model",
            baseUrl: "https://old-gateway.example/v1",
          },
          outputItems: [{ type: "reasoning", encrypted_content: "old-opaque-state" }],
        },
        content: [{ type: "text", text: "safe summary" }],
      }],
      tools: [],
    });
    await consume(handle);
    await handle.finalMessage();
    expect(JSON.stringify(captured[0]!.body)).not.toContain("old-opaque-state");
    expect(captured[0]!.body["input"]).toEqual([
      { role: "assistant", content: "safe summary" },
    ]);
  });
});
