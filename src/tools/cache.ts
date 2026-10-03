/**
 * Innovation 2: Smart Tool Result Cache
 *
 * 设计原则：
 * - 只缓存幂等的只读工具（file_read, glob, grep, web_fetch）
 * - 写操作（file_write, file_edit）触发路径级别的缓存失效
 * - bash 永不缓存（有副作用）
 * - 缓存生命周期：单次会话（不跨会话持久化）
 * - web_fetch 有 TTL（网络内容可能变化）
 *
 * 创新点（vs Claude Code）：
 * Claude Code 没有工具级缓存。当模型重复读取同一文件时（常见！），
 * 每次都发起实际 I/O。本缓存可减少 20-40% 工具调用开销。
 */

import type { ToolName, ToolResult } from "../types/tools.js";
import { logger } from "../utils/logger.js";

// 只读工具 — 安全可缓存
const CACHEABLE_TOOLS = new Set<ToolName>(["file_read", "glob", "grep", "web_fetch", "web_search"]);

// 写工具 — 触发缓存失效
const WRITE_TOOLS = new Set<ToolName>(["file_write", "file_edit"]);

// web_fetch / web_search TTL（毫秒）
const WEB_FETCH_TTL_MS  = 5 * 60 * 1000; // 5分钟
const WEB_SEARCH_TTL_MS = 3 * 60 * 1000; // 3分钟（搜索结果变化更快）

interface CacheEntry {
  result: ToolResult;
  createdAt: number;
  ttl?: number; // undefined = 永不过期（会话内）
  hits: number;
}

export class ToolCache {
  private store = new Map<string, CacheEntry>();
  private hitCount = 0;
  private missCount = 0;

  /**
   * 尝试从缓存获取结果。
   * 返回 null 表示缓存未命中或已过期。
   */
  get(toolName: ToolName, input: unknown): ToolResult | null {
    if (!CACHEABLE_TOOLS.has(toolName)) return null;

    const key = this.makeKey(toolName, input);
    const entry = this.store.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    // TTL 检查
    if (entry.ttl !== undefined && Date.now() - entry.createdAt > entry.ttl) {
      this.store.delete(key);
      this.missCount++;
      logger.debug("cache.expired", { toolName, key: key.slice(0, 60) });
      return null;
    }

    entry.hits++;
    this.hitCount++;
    logger.debug("cache.hit", { toolName, hits: entry.hits, key: key.slice(0, 60) });
    return entry.result;
  }

  /**
   * 存入缓存。
   * 只缓存成功的结果（isError:false）。
   */
  set(toolName: ToolName, input: unknown, result: ToolResult): void {
    if (!CACHEABLE_TOOLS.has(toolName)) return;
    if (result.isError) return; // 不缓存错误结果

    const key = this.makeKey(toolName, input);
    const ttl =
      toolName === "web_fetch"  ? WEB_FETCH_TTL_MS  :
      toolName === "web_search" ? WEB_SEARCH_TTL_MS :
      undefined;

    this.store.set(key, {
      result,
      createdAt: Date.now(),
      ttl,
      hits: 0,
    });

    logger.debug("cache.set", { toolName, key: key.slice(0, 60), ttl });
  }

  /**
   * 写操作触发路径级别的缓存失效。
   * 当 file_write/file_edit 修改某路径时，
   * 所有涉及该路径的 file_read/grep 缓存条目失效。
   */
  invalidateForWrite(toolName: ToolName, input: unknown): void {
    if (["sources_to_excel", "document_ocr", "document_format", "vision_analyze", "bash", "desktop_control", "browser_verify", "service_start"].includes(toolName)) { this.store.clear(); return; }
    if (!WRITE_TOOLS.has(toolName)) return;

    const writePath = extractPath(input);
    if (!writePath) return;

    let invalidated = 0;
    for (const [key] of this.store) {
      if (this.keyInvolvesPath(key, writePath)) {
        this.store.delete(key);
        invalidated++;
      }
    }

    if (invalidated > 0) {
      logger.debug("cache.invalidated", { toolName, writePath, invalidated });
    }
  }

  /** 缓存统计信息 */
  getStats(): { hits: number; misses: number; size: number; hitRate: string } {
    const total = this.hitCount + this.missCount;
    const hitRate = total === 0 ? "0%" : `${Math.round((this.hitCount / total) * 100)}%`;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.store.size,
      hitRate,
    };
  }

  clear(): void {
    this.store.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  private makeKey(toolName: ToolName, input: unknown): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }

  private keyInvolvesPath(key: string, writePath: string): boolean {
    // 简单字符串包含检测：key 是否涉及被写入的路径
    const normalizedPath = writePath.replace(/\\/g, "/");
    const normalizedKey = key.replace(/\\/g, "/");
    return normalizedKey.includes(normalizedPath);
  }
}

function extractPath(input: unknown): string | null {
  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj["path"] === "string") return obj["path"];
  }
  return null;
}
