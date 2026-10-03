import type { ProviderName } from "./interface.js";

const CANONICAL_MODEL_IDS: Partial<Record<ProviderName, ReadonlySet<string>>> = {
  deepseek: new Set([
    "deepseek-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-chat",
    "deepseek-reasoner",
  ]),
  moonshot: new Set([
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "kimi-k2.5",
  ]),
};

/**
 * Normalize only provider model identifiers whose casing contract is known.
 * Arbitrary future/custom model identifiers remain byte-for-byte intact.
 */
export function normalizeProviderModelId(
  provider: ProviderName | string,
  model: string,
): string {
  const trimmed = model.trim();
  const canonical = CANONICAL_MODEL_IDS[provider as ProviderName];
  if (!canonical) return trimmed;
  const lower = trimmed.toLowerCase();
  return canonical.has(lower) ? lower : trimmed;
}
