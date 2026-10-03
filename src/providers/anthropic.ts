import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  StreamParams,
  ProviderStreamHandle,
  NormalizedMessage,
  NormalizedDelta,
  NormalizedBlock,
} from "./interface.js";
import { logger } from "../utils/logger.js";

export class AnthropicProvider implements AIProvider {
  readonly providerName = "anthropic" as const;
  readonly protocol = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL });
  }

  stream(params: StreamParams): ProviderStreamHandle {
    const sdkStream = this.client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: [
          {
            type: "text",
            text: params.systemPrompt,
            cache_control: { type: "ephemeral" } as any,
          },
        ],
        tools: params.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        messages: params.messages.map(({ providerState: _providerState, ...message }) => message),
      },
      { signal: params.signal }
    );

    return new AnthropicStreamHandle(sdkStream);
  }
}

class AnthropicStreamHandle implements ProviderStreamHandle {
  constructor(private sdkStream: ReturnType<Anthropic["messages"]["stream"]>) {}

  async *deltas(): AsyncIterable<NormalizedDelta> {
    try {
      for await (const event of this.sdkStream) {
        if (event.type !== "content_block_delta") continue;

        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield {
            type: "thinking",
            text: (event.delta as { type: "thinking_delta"; thinking: string }).thinking,
          };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      logger.error("anthropic.stream.deltas.error", err);
      throw err;
    }
  }

  async finalMessage(): Promise<NormalizedMessage> {
    const msg = await this.sdkStream.finalMessage();

    const usage = msg.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    const content: NormalizedBlock[] = msg.content
      .map((block): NormalizedBlock | null => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_use")
          return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        return null;
      })
      .filter((b): b is NormalizedBlock => b !== null);

    return {
      stop_reason: (msg.stop_reason ?? "end_turn") as NormalizedMessage["stop_reason"],
      content,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
      },
    };
  }
}
