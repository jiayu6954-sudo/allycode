import type { ModelId, TokenUsage } from "../types/agent.js";
import {
  computeCost,
  formatAmount,
  type CostBreakdown,
  type Currency,
} from "./pricing.js";

export type { CostBreakdown, Currency } from "./pricing.js";
export { computeCost, explainMissing, findPrice, listPricedModels } from "./pricing.js";

/**
 * Cost for a session's usage.
 *
 * Returns `null` when the model has no registered price, or when a rate is
 * missing for tokens that were actually spent. The previous version silently
 * fell back to Claude Sonnet's table, so every DeepSeek, Kimi, Qwen and local
 * run displayed a confidently wrong figure — and, because the fallback had no
 * cache entry of its own, cache-read tokens were priced as if they were
 * Anthropic's. Cache reads are billed and can outnumber uncached input many
 * times over.
 */
export function calculateCost(
  model: ModelId,
  usage: Omit<TokenUsage, "estimatedCost" | "costCurrency">,
  provider?: string,
): { amount: number | null; currency: Currency | null; breakdown: CostBreakdown } {
  const breakdown = computeCost(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  }, provider);
  return { amount: breakdown.total, currency: breakdown.currency, breakdown };
}

/** Currency-aware. An unknown cost says so rather than printing $0.000. */
export function formatCost(amount: number | null, currency: Currency | null = "USD"): string {
  return formatAmount(amount, currency);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
