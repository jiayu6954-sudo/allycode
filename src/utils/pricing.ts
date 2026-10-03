/**
 * Model price registry.
 *
 * Cache-read tokens are billed, usually at a steep discount, and they dominate
 * long agent runs by volume: one recorded session logged 58.7M cache reads
 * against 2.2M uncached input — 27× more. Leaving the cache rate out of the
 * table did not make those tokens free, it made the reported cost wrong.
 *
 * Three rules hold everywhere in here:
 *   1. Cache HIT and cache MISS are separate rates. DeepSeek's differ by 12×.
 *   2. An unregistered model is UNKNOWN. Never fall back to another model's
 *      prices — a confident wrong number is worse than an honest blank.
 *   3. Every entry carries its source and effective date, so a stale or
 *      promotional rate can be recognised as such later.
 */

export type Currency = "CNY" | "USD";

export interface ModelPrice {
  provider: string;
  /** Canonical model id as the provider bills it. */
  model: string;
  currency: Currency;
  /** Per million tokens. `undefined` means genuinely unknown, never zero. */
  inputCacheMissPerMillion?: number;
  inputCacheHitPerMillion?: number;
  cacheWritePerMillion?: number;
  outputPerMillion?: number;
  source: string;
  /** Date the rates were verified. Prices move; a figure without a date lies. */
  asOf: string;
  note?: string;
}

const REGISTRY: ModelPrice[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    currency: "CNY",
    inputCacheMissPerMillion: 3,
    inputCacheHitPerMillion: 0.25,
    outputPerMillion: 6,
    source: "DeepSeek 官方定价（人民币）",
    asOf: "2026-08-27",
    note:
      "缓存命中 ¥0.25/M 为限时促销价，与未命中相差 12 倍；促销结束后须重新核验。" +
      "cacheWrite 未在官方页面单列，按未知处理。",
  },
  // Anthropic rates predate this registry and were not re-verified in the
  // pass that added cache pricing. They are kept because they were already in
  // use, and marked so their provenance is not mistaken for a checked source.
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    currency: "USD",
    inputCacheMissPerMillion: 15,
    inputCacheHitPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
    outputPerMillion: 75,
    source: "内置默认值（未在本轮重新核验）",
    asOf: "2025-01-01",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    currency: "USD",
    inputCacheMissPerMillion: 3,
    inputCacheHitPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    outputPerMillion: 15,
    source: "内置默认值（未在本轮重新核验）",
    asOf: "2025-01-01",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-5",
    currency: "USD",
    inputCacheMissPerMillion: 15,
    inputCacheHitPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
    outputPerMillion: 75,
    source: "内置默认值（未在本轮重新核验）",
    asOf: "2025-01-01",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    currency: "USD",
    inputCacheMissPerMillion: 3,
    inputCacheHitPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    outputPerMillion: 15,
    source: "内置默认值（未在本轮重新核验）",
    asOf: "2025-01-01",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    currency: "USD",
    inputCacheMissPerMillion: 0.8,
    inputCacheHitPerMillion: 0.08,
    cacheWritePerMillion: 1,
    outputPerMillion: 4,
    source: "内置默认值（未在本轮重新核验）",
    asOf: "2025-01-01",
  },
];

/** Exact model match only. A near-miss is an unknown model, not a close one. */
export function findPrice(model: string, provider?: string, at = new Date()): ModelPrice | null {
  const wanted = model.trim().toLowerCase();
  if ((!provider || provider === "deepseek") && ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"].includes(wanted)) {
    const hour = at.getUTCHours();
    const peak = at.getUTCDay() >= 1 && at.getUTCDay() <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const scale = peak ? 2 : 1;
    const pro = wanted === "deepseek-v4-pro";
    return { provider: "deepseek", model: wanted, currency: "USD", inputCacheMissPerMillion: (pro ? 0.66 : 0.15) * scale, inputCacheHitPerMillion: (pro ? 0.022 : 0.003) * scale, outputPerMillion: (pro ? 1.98 : 0.6) * scale, source: "https://api-docs.deepseek.com/quick_start/pricing/", asOf: "2026-09-15", note: `${peak ? "峰时" : "谷时"}美元价估算；跨时段请求以供应商账单为准。人民币余额不与美元直接相减。` };
  }
  return REGISTRY.find((entry) =>
    entry.model.toLowerCase() === wanted &&
    (provider === undefined || entry.provider === provider.toLowerCase())) ?? null;
}

export function listPricedModels(): ModelPrice[] {
  return [...REGISTRY.filter((entry) => entry.provider !== "deepseek"), findPrice("deepseek-flash")!, findPrice("deepseek-v4-pro")!].map((entry) => ({ ...entry }));
}

export interface UsageForPricing {
  /** Input tokens the provider did NOT serve from cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CostComponent {
  tokens: number;
  /** null when the rate is unknown — distinct from a rate of zero. */
  amount: number | null;
  rate: number | null;
}

export interface CostBreakdown {
  model: string;
  currency: Currency | null;
  /** null when any billed component has no known rate. */
  total: number | null;
  uncachedInput: CostComponent;
  cacheRead: CostComponent;
  cacheWrite: CostComponent;
  output: CostComponent;
  /** Rates that were needed for non-zero token counts but are unregistered. */
  missingRates: string[];
  price: ModelPrice | null;
}

function component(tokens: number, rate: number | undefined): CostComponent {
  if (tokens === 0) return { tokens: 0, amount: 0, rate: rate ?? null };
  if (rate === undefined) return { tokens, amount: null, rate: null };
  return { tokens, amount: (tokens / 1_000_000) * rate, rate };
}

/**
 * Cost for a usage record. Returns `total: null` whenever a rate is missing for
 * tokens that were actually consumed, so an incomplete price table surfaces as
 * "unknown" rather than as a plausible-looking undercount.
 */
export function computeCost(
  model: string,
  usage: UsageForPricing,
  provider?: string,
  at = new Date(),
): CostBreakdown {
  const price = findPrice(model, provider, at);
  const uncachedInput = component(usage.inputTokens, price?.inputCacheMissPerMillion);
  const cacheRead = component(usage.cacheReadTokens, price?.inputCacheHitPerMillion);
  const cacheWrite = component(usage.cacheWriteTokens, price?.cacheWritePerMillion);
  const output = component(usage.outputTokens, price?.outputPerMillion);

  const missingRates: string[] = [];
  if (!price) {
    missingRates.push(`未注册的模型：${model}`);
  } else {
    if (uncachedInput.amount === null) missingRates.push("未缓存输入单价");
    if (cacheRead.amount === null) missingRates.push("缓存命中单价");
    if (cacheWrite.amount === null) missingRates.push("缓存写入单价");
    if (output.amount === null) missingRates.push("输出单价");
  }

  const parts = [uncachedInput, cacheRead, cacheWrite, output];
  const total = missingRates.length > 0
    ? null
    : parts.reduce((sum, part) => sum + (part.amount ?? 0), 0);

  return {
    model,
    currency: price?.currency ?? null,
    total,
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    missingRates,
    price,
  };
}

const SYMBOL: Record<Currency, string> = { CNY: "¥", USD: "$" };

export function formatAmount(amount: number | null, currency: Currency | null): string {
  if (amount === null || currency === null) return "费用未知";
  const symbol = SYMBOL[currency];
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.001) return `<${symbol}0.001`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(3)}`;
}

/** One-line explanation of why a cost could not be computed. */
export function explainMissing(breakdown: CostBreakdown): string | null {
  if (breakdown.missingRates.length === 0) return null;
  return `无法计算费用：缺少 ${breakdown.missingRates.join("、")}。不回退到其他模型价格。`;
}
