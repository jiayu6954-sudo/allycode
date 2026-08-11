import type { ProviderStreamHandle } from "../providers/interface.js";
import type { AgentEvent } from "../types/agent.js";
import { logger } from "../utils/logger.js";

/**
 * Processes a provider stream handle and fires typed AgentEvents.
 * Provider-agnostic: works with both Anthropic and any OAI-compatible provider.
 */
export class StreamHandler {
  constructor(private onEvent: (event: AgentEvent) => void) {}

  async process(stream: ProviderStreamHandle, signal?: AbortSignal): Promise<void> {
    try {
      for await (const delta of stream.deltas()) {
        if (signal?.aborted) break;

        if (delta.type === "text") {
          this.onEvent({ type: "text_delta", delta: delta.text });
        } else if (delta.type === "thinking") {
          this.onEvent({ type: "thinking_delta", delta: delta.text });
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"))
      ) {
        this.onEvent({ type: "error", error: new Error("Stream aborted") });
        return;
      }
      logger.error("stream.process.error", err);
      this.onEvent({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
