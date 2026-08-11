/**
 * Innovation 4: Session Statistics Tracker
 *
 * 在会话结束时提供工具使用报告 + 成本分析。
 * Claude Code 没有这个功能 — 用户无法知道哪些工具最耗资源。
 *
 * 输出示例：
 * ─────────────────────────────────────────
 *  会话统计 #a1b2c3d4
 * ─────────────────────────────────────────
 *  工具调用        次数   占成本
 *  file_read       34    2%
 *  bash            12    8%
 *  file_edit        8    1%
 *  grep             6    1%
 *  web_fetch        3    4%
 *  ───────────────────────────────────────
 *  模型推理                    84%
 *  Token: 45.2K in / 8.3K out / 12.1K cached
 *  总成本: $0.024  (缓存节省: $0.008)
 * ─────────────────────────────────────────
 */

import type { ToolName } from "../types/tools.js";
import type { ModelId, TokenUsage } from "../types/agent.js";
import { calculateCost, formatCost, formatTokens } from "./cost-calculator.js";

interface ToolStat {
  calls: number;
  cacheHits: number;
  errors: number;
}

export class SessionStats {
  private toolStats = new Map<ToolName, ToolStat>();
  private startTime = Date.now();
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
  private savedByCache = 0; // 因缓存命中节省的估算成本（USD）

  recordToolCall(toolName: ToolName, fromCache: boolean, isError: boolean): void {
    const existing = this.toolStats.get(toolName) ?? { calls: 0, cacheHits: 0, errors: 0 };
    this.toolStats.set(toolName, {
      calls: existing.calls + 1,
      cacheHits: existing.cacheHits + (fromCache ? 1 : 0),
      errors: existing.errors + (isError ? 1 : 0),
    });

    // 粗略估算缓存节省：每次缓存命中约等于节省一次 file_read 调用的 I/O 成本
    // 在成本上体现为节省了约 500 input tokens 的处理
    if (fromCache) {
      this.savedByCache += (500 / 1_000_000) * 3.0; // sonnet input price
    }
  }

  updateUsage(partial: Partial<TokenUsage>): void {
    if (partial.inputTokens) this.usage.inputTokens += partial.inputTokens;
    if (partial.outputTokens) this.usage.outputTokens += partial.outputTokens;
    if (partial.cacheReadTokens) this.usage.cacheReadTokens += partial.cacheReadTokens;
    if (partial.cacheWriteTokens) this.usage.cacheWriteTokens += partial.cacheWriteTokens;
    this.usage.estimatedCostUsd = calculateCost("claude-sonnet-4-6", this.usage);
  }

  setFinalUsage(usage: TokenUsage): void {
    this.usage = { ...usage };
  }

  /** 生成格式化报告字符串 */
  formatReport(sessionId: string, model: ModelId): string {
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const lines: string[] = [];
    const sep = "─".repeat(52);

    lines.push(sep);
    lines.push(` 会话统计  #${sessionId.slice(0, 8)}  [${formatElapsed(elapsed)}]`);
    lines.push(sep);

    // 工具调用表
    if (this.toolStats.size > 0) {
      lines.push(" 工具               调用  缓存  错误");
      lines.push(" " + "─".repeat(40));

      const sorted = [...this.toolStats.entries()].sort(
        (a, b) => b[1].calls - a[1].calls
      );

      for (const [name, stat] of sorted) {
        const nameCol = name.padEnd(18);
        const callsCol = String(stat.calls).padStart(4);
        const cacheCol = stat.cacheHits > 0 ? String(stat.cacheHits).padStart(4) + "✓" : "    -";
        const errCol = stat.errors > 0 ? String(stat.errors).padStart(4) + "✗" : "    -";
        lines.push(` ${nameCol}${callsCol}  ${cacheCol}  ${errCol}`);
      }
    } else {
      lines.push(" (未调用任何工具)");
    }

    lines.push(sep);

    // Token 统计
    const totalIn = this.usage.inputTokens + this.usage.cacheReadTokens;
    const totalOut = this.usage.outputTokens;
    lines.push(` Token:  ${formatTokens(totalIn)} 输入 / ${formatTokens(totalOut)} 输出`);
    if (this.usage.cacheReadTokens > 0) {
      lines.push(` 缓存:   ${formatTokens(this.usage.cacheReadTokens)} 命中 / ${formatTokens(this.usage.cacheWriteTokens)} 写入`);
    }

    // 成本
    lines.push(` 模型:   ${model}`);
    lines.push(` 总成本: ${formatCost(this.usage.estimatedCostUsd)}`);
    if (this.savedByCache > 0) {
      lines.push(` 缓存省: ~${formatCost(this.savedByCache)}`);
    }

    lines.push(sep);
    return lines.join("\n");
  }

  getTotalCalls(): number {
    let total = 0;
    for (const stat of this.toolStats.values()) total += stat.calls;
    return total;
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}
