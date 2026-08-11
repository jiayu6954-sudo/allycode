/**
 * I022: web_search — Multi-provider web search tool
 *
 * Provider cascade (auto mode picks first available key):
 *   Tavily → Brave → Serper → DuckDuckGo (no-key fallback)
 *
 * - Tavily:     Best quality, AI-optimised result snippets, requires API key
 * - Brave:      Privacy-first, generous free tier, requires API key
 * - Serper:     Google SERP results, 2500 free/mo, requires API key
 * - DuckDuckGo: No key needed — scrapes lite.duckduckgo.com as last resort
 *
 * DeerFlow-2.0 inspiration: Researcher sub-agent used multi-provider search
 * as its core capability. This brings equivalent power to a single-agent CLI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";
import type { ToolResult, ToolExecutionContext } from "../types/tools.js";

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 8;

export interface WebSearchInput {
  query: string;
  provider?: "auto" | "searxng" | "tavily" | "brave" | "serper" | "duckduckgo";
  maxResults?: number;
}

export interface SearchConfig {
  searxngUrl?: string;
  tavilyApiKey?: string;
  braveApiKey?: string;
  serperApiKey?: string;
  defaultProvider?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchSearxng(
  query: string,
  baseUrl: string,
  max: number,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const endpoint = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("language", "zh-CN");
    endpoint.searchParams.set("safesearch", "1");
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
    const data = await response.json() as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? [])
      .filter((item) => item.url?.startsWith("http"))
      .slice(0, max)
      .map((item) => ({
        title: item.title?.trim() || item.url!,
        url: item.url!,
        snippet: item.content?.trim() ?? "",
      }));
  } finally {
    clearTimeout(timeout);
  }
}

// ── Provider: Tavily ──────────────────────────────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string,
  max: number,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: max,
        search_depth: "basic",
        include_answer: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json() as {
      results: Array<{ title: string; url: string; content: string }>;
    };
    return data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  } finally {
    clearTimeout(t);
  }
}

// ── Provider: Brave Search ────────────────────────────────────────────────────

async function searchBrave(
  query: string,
  apiKey: string,
  max: number,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json() as {
      web?: { results: Array<{ title: string; url: string; description: string }> };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  } finally {
    clearTimeout(t);
  }
}

// ── Provider: Serper (Google SERP) ───────────────────────────────────────────

async function searchSerper(
  query: string,
  apiKey: string,
  max: number,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ q: query, num: max }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json() as {
      organic: Array<{ title: string; link: string; snippet: string }>;
    };
    return (data.organic ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));
  } finally {
    clearTimeout(t);
  }
}

// ── Provider: DuckDuckGo (free, no key) ──────────────────────────────────────

async function searchDDG(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  let html = "";

  // Attempt 1: native fetch
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.ok) html = await res.text();
    } finally {
      clearTimeout(t);
    }
  } catch {
    /* fall through to curl */
  }

  // Attempt 2: curl fallback (handles HTTP/2 / proxy issues on Windows)
  if (!html) {
    try {
      const { stdout } = await execFileAsync(
        CURL_BIN,
        ["-sL", "--max-time", "15", "-A", UA, url],
        { maxBuffer: 2 * 1024 * 1024 },
      );
      html = stdout;
    } catch (e) {
      logger.warn("web_search.ddg_curl_failed", { error: String(e) });
      return [];
    }
  }

  if (!html) return [];
  return parseDDGLite(html, max);
}

function parseDDGLite(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG lite HTML structure:
  //   <a class="result-link" href="url">title</a>
  //   <td class="result-snippet">snippet text</td>
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  const snipRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(html)) !== null && links.length < max) {
    const url = m[1] ?? "";
    const title = decodeHTMLEntities((m[2] ?? "").trim());
    if (url.startsWith("http")) links.push({ url, title });
  }

  const snips: string[] = [];
  while ((m = snipRe.exec(html)) !== null) {
    snips.push(
      decodeHTMLEntities(
        (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      ),
    );
  }

  for (let i = 0; i < Math.min(links.length, max); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snips[i] ?? "",
    });
  }
  return results;
}

function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n)));
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function executeWebSearch(
  input: WebSearchInput,
  _ctx: ToolExecutionContext,
  config: SearchConfig,
): Promise<ToolResult> {
  const query = input.query.trim();
  if (!query) return { content: "Error: query cannot be empty", isError: true };

  const max = Math.min(input.maxResults ?? DEFAULT_MAX_RESULTS, 20);

  // Auto-select: first provider that has a configured key, else DDG
  let provider = (input.provider ?? config.defaultProvider ?? "auto") as string;
  if (provider === "auto") {
    if (config.searxngUrl) provider = "searxng";
    else if (config.tavilyApiKey) provider = "tavily";
    else if (config.braveApiKey) provider = "brave";
    else if (config.serperApiKey) provider = "serper";
    else provider = "duckduckgo";
  }

  logger.debug("web_search.start", { query, provider, max });

  let results: SearchResult[];
  let usedProvider = provider;

  try {
    switch (provider) {
      case "searxng":
        if (!config.searxngUrl)
          throw new Error("SearXNG URL not set — add search.searxngUrl to AllyCode settings");
        results = await searchSearxng(query, config.searxngUrl, max);
        break;
      case "tavily":
        if (!config.tavilyApiKey)
          throw new Error("Tavily key not set — add search.tavilyApiKey to ~/.allycode/settings.json");
        results = await searchTavily(query, config.tavilyApiKey, max);
        break;
      case "brave":
        if (!config.braveApiKey)
          throw new Error("Brave key not set — add search.braveApiKey to ~/.allycode/settings.json");
        results = await searchBrave(query, config.braveApiKey, max);
        break;
      case "serper":
        if (!config.serperApiKey)
          throw new Error("Serper key not set — add search.serperApiKey to ~/.allycode/settings.json");
        results = await searchSerper(query, config.serperApiKey, max);
        break;
      default: // duckduckgo
        results = await searchDDG(query, max);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("web_search.provider_error", { provider, error: msg });

    // Prefer a user-controlled domestic/private SearXNG deployment, then DDG.
    if (provider !== "searxng" && config.searxngUrl) {
      logger.info("web_search.cascade_to_searxng", { from: provider });
      usedProvider = "searxng";
      try {
        results = await searchSearxng(query, config.searxngUrl, max);
      } catch {
        usedProvider = "duckduckgo";
        results = await searchDDG(query, max);
      }
    } else if (provider !== "duckduckgo") {
      logger.info("web_search.cascade_to_ddg", { from: provider });
      usedProvider = "duckduckgo";
      results = await searchDDG(query, max);
    } else {
      return { content: `Search failed: ${msg}`, isError: true };
    }
  }

  if (results.length === 0) {
    return {
      content: `No results found for: "${query}" (via ${usedProvider})`,
      isError: false,
    };
  }

  // Format results as numbered list with title / URL / snippet
  const lines: string[] = [
    `Search: "${query}"  [${usedProvider} · ${results.length} results]`,
    "",
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }

  logger.info("web_search.done", { provider: usedProvider, count: results.length });
  return {
    content: lines.join("\n"),
    isError: false,
    metadata: { matchCount: results.length },
  };
}
