import type { ModelId, TokenUsage } from "../types/agent.js";

// Prices in USD per million tokens (as of 2025)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-6":          { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "claude-sonnet-4-6":        { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-opus-4-5":          { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "claude-sonnet-4-5":        { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
};

export function calculateCost(model: ModelId, usage: Omit<TokenUsage, "estimatedCostUsd">): number {
  const prices = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
  const M = 1_000_000;

  return (
    (usage.inputTokens / M) * prices.input +
    (usage.outputTokens / M) * prices.output +
    (usage.cacheReadTokens / M) * prices.cacheRead +
    (usage.cacheWriteTokens / M) * prices.cacheWrite
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
