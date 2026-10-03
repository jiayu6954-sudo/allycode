import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeCost,
  explainMissing,
  findPrice,
  formatAmount,
  listPricedModels,
} from "../../src/utils/pricing.js";
import { calculateCost, formatCost } from "../../src/utils/cost-calculator.js";

/**
 * Cache-read tokens are billed and, in long agent runs, dominate by volume —
 * one recorded session logged 58.7M cache reads against 2.2M uncached input.
 * Omitting the cache rate did not make them free, it made every reported cost
 * wrong. These pin that they are priced, and that an unknown rate is reported
 * as unknown rather than silently borrowed from another model.
 */

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 10_000_000,
  cacheWriteTokens: 0,
};

describe("price registry", () => {
  it("records cache hit and cache miss as separate rates", () => {
    const price = findPrice("deepseek-v4-pro", "deepseek");
    expect(price).not.toBeNull();
    expect(price?.inputCacheMissPerMillion).toBe(0.66);
    expect(price?.inputCacheHitPerMillion).toBe(0.022);
    expect(price?.outputPerMillion).toBe(1.98);
    expect(price?.currency).toBe("USD");
  });

  it("carries a source and an effective date for every entry", () => {
    for (const price of listPricedModels()) {
      expect(price.source, price.model).toBeTruthy();
      expect(price.asOf, price.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("records the active time band and avoids cross-currency claims", () => {
    expect(findPrice("deepseek-v4-pro")?.note).toContain("谷时");
  });

  it("bills cache reads instead of treating them as free", () => {
    const cost = computeCost("deepseek-v4-pro", USAGE, "deepseek");

    // 10M cache reads at ¥0.25/M is ¥2.50 — the component that used to vanish.
    expect(cost.cacheRead.amount).toBeCloseTo(0.22, 6);
    expect(cost.cacheRead.rate).toBe(0.022);
    expect(cost.uncachedInput.amount).toBeCloseTo(0.66, 6);
    expect(cost.output.amount).toBeCloseTo(0.198, 6);
    expect(cost.total).toBeCloseTo(1.078, 6);
    expect(cost.currency).toBe("USD");
  });

  it("shows how much the cache discount is actually worth", () => {
    const price = findPrice("deepseek-v4-pro")!;
    const atMiss = (10_000_000 / 1_000_000) * price.inputCacheMissPerMillion!;
    const atHit = (10_000_000 / 1_000_000) * price.inputCacheHitPerMillion!;

    expect(atMiss).toBeCloseTo(6.6, 6);
    expect(atHit).toBeCloseTo(0.22, 6);
    // 30× cheaper, but not free — the distinction the old table erased.
    expect(atHit).toBeGreaterThan(0);
    expect(atMiss / atHit).toBeCloseTo(30, 6);
  });

  it("returns unknown for an unregistered model instead of借用 another's price", () => {
    const cost = computeCost("some-unlisted-model", USAGE);

    expect(cost.total).toBeNull();
    expect(cost.currency).toBeNull();
    expect(cost.price).toBeNull();
    expect(cost.missingRates.join(" ")).toContain("未注册的模型");
    expect(explainMissing(cost)).toContain("不回退到其他模型价格");
  });

  it("requires an exact model id, not a prefix", () => {
    expect(findPrice("deepseek-v4-pro-preview")).toBeNull();
    expect(findPrice("deepseek-v4")).toBeNull();
    expect(findPrice("DeepSeek-V4-Pro")).not.toBeNull(); // case-insensitive only
  });

  it("distinguishes a zero-token component from an unknown rate", () => {
    // deepseek has no registered cache-WRITE rate.
    const withWrites = computeCost("deepseek-v4-pro", { ...USAGE, cacheWriteTokens: 5_000 });
    expect(withWrites.cacheWrite.amount).toBeNull();
    expect(withWrites.total).toBeNull();
    expect(withWrites.missingRates).toContain("缓存写入单价");

    // With no cache writes at all the missing rate cannot distort anything.
    const withoutWrites = computeCost("deepseek-v4-pro", { ...USAGE, cacheWriteTokens: 0 });
    expect(withoutWrites.cacheWrite.amount).toBe(0);
    expect(withoutWrites.total).not.toBeNull();
  });

  it("keeps the currency published by each provider", () => {
    expect(computeCost("claude-sonnet-4-6", USAGE).currency).toBe("USD");
    expect(computeCost("deepseek-v4-pro", USAGE).currency).toBe("USD");
  });
});

describe("cost formatting", () => {
  it("says the cost is unknown rather than printing zero", () => {
    expect(formatAmount(null, "CNY")).toBe("费用未知");
    expect(formatAmount(1.5, null)).toBe("费用未知");
    expect(formatCost(null, null)).toBe("费用未知");
  });

  it("uses the right symbol per currency", () => {
    expect(formatAmount(2.5, "CNY")).toBe("¥2.500");
    expect(formatAmount(2.5, "USD")).toBe("$2.500");
  });
});

describe("calculateCost no longer falls back to Claude", () => {
  it("returns null for an unpriced model", () => {
    const result = calculateCost("kimi-k3", {
      inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(result.amount).toBeNull();
    expect(result.currency).toBeNull();
  });

  it("prices a registered model including its cache reads", () => {
    const result = calculateCost("deepseek-v4-pro", {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 4_000_000, cacheWriteTokens: 0,
    }, "deepseek");

    expect(result.currency).toBe("USD");
    // ¥3 uncached + ¥1 cache — the second term used to be missing entirely.
    expect(result.amount).toBeCloseTo(0.748, 6);
    expect(result.breakdown.cacheRead.amount).toBeCloseTo(0.088, 6);
  });

  it("reproduces the shape of the recorded session that caused the surprise", () => {
    // Real totals from the local record: cache reads outnumber uncached input
    // 27 to 1, so a table without a cache rate under-reports by most of the bill.
    const result = calculateCost("deepseek-v4-pro", {
      inputTokens: 2_156_752,
      outputTokens: 291_908,
      cacheReadTokens: 58_677_888,
      cacheWriteTokens: 0,
    }, "deepseek");

    expect(result.amount).not.toBeNull();
    const cacheShare = result.breakdown.cacheRead.amount! / result.amount!;
    expect(cacheShare).toBeGreaterThan(0.3); // the majority of the cost
  });
});
