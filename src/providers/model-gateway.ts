import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AIProvider, NormalizedMessage, ProviderStreamHandle, StreamParams } from "./interface.js";
import type { AgentLoopOptions, TokenUsage } from "../types/agent.js";
import { estimateHistoryTokens, estimateTokens } from "../agent/history-budget.js";
import { computeCost } from "../utils/pricing.js";
import { ProviderFailure, type ProviderFailureDiagnostic } from "./failure-diagnostics.js";

export interface ModelCallRecord {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  startedAt: string;
  endedAt?: string;
  reservedTokens: number;
  status: "reserved" | "reported" | "unknown";
  failureKind?: "request_error" | "stream_error" | "aborted" | "missing_usage" | "finalization_error";
  diagnostic?: ProviderFailureDiagnostic;
  durationMs?: number;
  usage?: TokenUsage;
  priceAsOf?: string;
  priceSnapshot?: import("../utils/pricing.js").ModelPrice;
}
interface AccountingScope {
  totals: TokenUsage;
  reserved: number;
  prior: number;
  limit?: number;
  event: AgentLoopOptions["onEvent"];
  purpose: string;
}
const scopes = new AsyncLocalStorage<AccountingScope>();
const METERED = Symbol("metered-provider");
export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: null, costCurrency: null, unknownCalls: 0 });
export const consumedTokens = (usage: TokenUsage): number => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + (usage.unknownReservedTokens ?? 0);

export async function withModelAccounting<T>(options: AgentLoopOptions, callback: (totals: TokenUsage) => Promise<T>): Promise<T> {
  const parent = scopes.getStore();
  if (parent) return callback(parent.totals);
  const scope: AccountingScope = { totals: emptyUsage(), reserved: 0, prior: options.tokenBudget?.priorTokens ?? 0, limit: options.tokenBudget?.hardLimit, event: options.onEvent, purpose: "main" };
  return scopes.run(scope, () => callback(scope.totals));
}

export function meteredProvider(provider: AIProvider): AIProvider {
  if ((provider as AIProvider & { [METERED]?: boolean })[METERED]) return provider;
  return Object.assign({
    providerName: provider.providerName,
    protocol: provider.protocol,
    stream(params: StreamParams): ProviderStreamHandle {
      const scope = scopes.getStore();
      if (!scope) return provider.stream(params);
      const reserved = estimateHistoryTokens(params.messages) + estimateTokens(params.systemPrompt) + estimateTokens(JSON.stringify(params.tools)) + params.maxTokens + 512;
      if (scope.limit !== undefined && scope.prior + consumedTokens(scope.totals) + scope.reserved + reserved > scope.limit) {
        throw new Error("Token budget: 剩余预算不足以预留本次请求及最大输出。请提高预算后继续。");
      }
      scope.reserved += reserved;
      const record: ModelCallRecord = { id: randomUUID(), provider: provider.providerName, model: params.model, purpose: params.purpose ?? scope.purpose, startedAt: new Date().toISOString(), reservedTokens: reserved, status: "reserved" };
      scope.event({ type: "model_call", record: { ...record } });
      let settled = false;
      const settle = (message?: NormalizedMessage, failureKind?: ModelCallRecord["failureKind"], error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error instanceof ProviderFailure) {
          record.diagnostic = error.diagnostic;
          if (error.reportedUsage) message = {stop_reason:"end_turn",content:[],usage:error.reportedUsage};
        }
        if (failureKind) record.failureKind = failureKind;
        const known = message && message.usage.reported !== false && [message.usage.input_tokens, message.usage.output_tokens, message.usage.cache_read_input_tokens ?? 0, message.usage.cache_creation_input_tokens ?? 0].every((value) => Number.isFinite(value) && value >= 0);
        record.status = known ? "reported" : "unknown";
        record.endedAt = new Date().toISOString();
        record.durationMs = Math.max(0,Date.parse(record.endedAt)-Date.parse(record.startedAt));
        if (!known || !message) {
          record.failureKind = params.signal?.aborted ? "aborted" : failureKind ?? "missing_usage";
          scope.totals.unknownCalls = (scope.totals.unknownCalls ?? 0) + 1;
          scope.totals.estimatedCost = null;
          scope.reserved -= reserved;
          scope.totals.unknownReservedTokens = (scope.totals.unknownReservedTokens ?? 0) + reserved;
        } else {
          scope.reserved -= reserved;
          const usage: TokenUsage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0, estimatedCost: null, costCurrency: null };
          const price = computeCost(params.model, usage, provider.providerName, new Date(record.startedAt));
          usage.estimatedCost = price.total;
          usage.costCurrency = price.currency;
          const first = consumedTokens(scope.totals) === 0 && !(scope.totals.unknownCalls);
          const compatible = first || (scope.totals.estimatedCost !== null && scope.totals.costCurrency === price.currency);
          scope.totals.estimatedCost = compatible && price.total !== null ? (first ? 0 : scope.totals.estimatedCost!) + price.total : null;
          scope.totals.costCurrency = first || scope.totals.costCurrency === price.currency ? price.currency : null;
          scope.totals.inputTokens += usage.inputTokens;
          scope.totals.outputTokens += usage.outputTokens;
          scope.totals.cacheReadTokens += usage.cacheReadTokens;
          scope.totals.cacheWriteTokens += usage.cacheWriteTokens;
          record.usage = usage;
          record.priceAsOf = price.price?.asOf;
          record.priceSnapshot = price.price ?? undefined;
          scope.event({ type: "usage", ...usage, purpose: record.purpose, model: params.model });
        }
        scope.event({ type: "model_call", record: { ...record } });
      };
      let handle: ProviderStreamHandle;
      try { handle = provider.stream(params); } catch (error) { settle(undefined,"request_error",error); throw error; }
      let final: Promise<NormalizedMessage> | undefined;
      return {
        async *deltas() {
          let complete = false;
          try { yield* handle.deltas(); complete = true; } catch (error) { settle(undefined,"stream_error",error); throw error; }
          finally { if (!complete || params.signal?.aborted) settle(undefined,"aborted"); }
        },
        finalMessage() {
          final ??= handle.finalMessage().then((message) => { settle(message); return message; }, (error: unknown) => { settle(undefined,"finalization_error",error); throw error; });
          return final;
        },
      };
    },
  }, { [METERED]: true });
}

/** Historical costs are added at their original model/price, never repriced. */
export function addUsage(previous: TokenUsage, next: TokenUsage): TokenUsage {
  if (consumedTokens(next) === 0 && !next.unknownCalls) return { ...previous };
  const first = consumedTokens(previous) === 0 && !previous.unknownCalls;
  const compatible = first || previous.costCurrency === next.costCurrency;
  return {
    inputTokens: previous.inputTokens + next.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: previous.cacheWriteTokens + next.cacheWriteTokens,
    estimatedCost: compatible && next.estimatedCost !== null && (first || previous.estimatedCost !== null) ? (first ? 0 : previous.estimatedCost!) + next.estimatedCost : null,
    costCurrency: compatible ? next.costCurrency : null,
    unknownCalls: (previous.unknownCalls ?? 0) + (next.unknownCalls ?? 0),
    unknownReservedTokens: (previous.unknownReservedTokens ?? 0) + (next.unknownReservedTokens ?? 0),
  };
}
