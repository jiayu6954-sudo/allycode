/**
 * web_fetch — HTTP/HTTPS content retrieval tool.
 *
 * v0.8.0: curl fallback for sites that block Node.js fetch()
 * v0.9.2: Mozilla Readability integration (I028-pre)
 *   - Replaces naive regex stripHtml with article-aware content extraction
 *   - Strips ads, navbars, footers, cookie banners — keeps main content
 *   - Preserves code blocks, tables, lists with structural markers
 *   - Falls back to enhanced stripHtml for non-article pages (data tables, APIs)
 *   - Optimised for scientific sources: PubMed, arXiv, NCBI, UniProt
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { WebFetchInput, ToolResult, ToolExecutionContext } from "../types/tools.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BYTES = 80_000;   // raised from 50K — HTML pages need room
const FETCH_TIMEOUT_MS  = 15_000;   // for native fetch()
const CURL_TIMEOUT_S    = 20;       // for curl fallback

/** Realistic browser User-Agent (Chrome 124 on Windows 11) */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";

/** Sentinel appended by curl to the response body so we can extract metadata */
const CURL_META_SEP = "\n__CURL_META__";

export async function executeWebFetch(
  input: WebFetchInput,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return { content: "Error: Invalid URL", isError: true };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { content: "Error: URL must use http:// or https://", isError: true };
  }
  if (isMetadataEndpoint(parsedUrl.hostname)) {
    return {
      content: "Error: Cloud metadata and link-local endpoints are blocked.",
      isError: true,
    };
  }

  logger.debug("web_fetch.execute", { url: input.url, maxBytes });

  // ── GitHub API: special handling ─────────────────────────────────────────
  // api.github.com responses are JSON. File contents are base64-encoded.
  // We decode them and return clean text so AI can read source directly.
  if (input.url.startsWith("https://api.github.com/")) {
    return fetchGitHub(input, ctx);
  }

  // Derive Referer: explicit override wins, then URL's own origin as fallback
  let referer = input.referer ?? "";
  if (!referer) {
    try {
      const parsed = new URL(input.url);
      referer = `${parsed.protocol}//${parsed.host}/`;
    } catch { /* ignore */ }
  }

  // ── Attempt 1: native fetch() ────────────────────────────────────────────
  const nativeResult = await tryNativeFetch(input, ctx, maxBytes, referer);
  if (nativeResult !== null) return nativeResult;

  // ── Attempt 2: curl fallback ─────────────────────────────────────────────
  logger.debug("web_fetch.curl_fallback", { url: input.url });
  return tryCurlFetch(input, ctx, maxBytes, referer);
}

// ── Native fetch ───────────────────────────────────────────────────────────

async function tryNativeFetch(
  input: WebFetchInput,
  ctx: ToolExecutionContext,
  maxBytes: number,
  referer: string,
): Promise<ToolResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  if (ctx.signal) {
    ctx.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const response = await fetch(input.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":       BROWSER_UA,
        "Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
        "Accept-Language":  "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding":  "identity",
        "Cache-Control":    "no-cache",
        "Pragma":           "no-cache",
        ...(referer && { "Referer": referer }),
        ...(input.headers ?? {}),
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      const hint = httpHint(response.status, input.url);
      // For 403/429/401: don't fall back to curl (it will likely get same result)
      return {
        content: `HTTP ${response.status} ${response.statusText} — ${input.url}\n${hint}`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    const full   = new Uint8Array(buffer);
    const slice  = full.slice(0, maxBytes);
    const truncated = full.byteLength > maxBytes;

    const charset = extractCharset(contentType) ?? "utf-8";
    const raw = decode(slice, charset);

    return buildResult(input.url, contentType, raw, maxBytes, truncated);
  } catch (err) {
    clearTimeout(timer);

    if (err instanceof Error && err.name === "AbortError") {
      // Timeout → try curl fallback (return null to signal fallback)
      logger.debug("web_fetch.native_timeout", { url: input.url });
      return null;
    }

    const msg = err instanceof Error ? err.message : String(err);
    const lc = msg.toLowerCase();

    // Connection-level errors → try curl fallback
    if (lc.includes("econnrefused") || lc.includes("enotfound") ||
        lc.includes("econnreset") || lc.includes("fetch failed") ||
        lc.includes("network") || lc.includes("certificate")) {
      logger.debug("web_fetch.native_error_fallback", { url: input.url, msg });
      return null;
    }

    // Unknown error — return it directly
    logger.error("web_fetch.native_error", err);
    return {
      content: `web_fetch error: ${msg}\n${networkTip(msg, input.url)}`,
      isError: true,
    };
  }
}

// ── curl fallback ──────────────────────────────────────────────────────────

async function tryCurlFetch(
  input: WebFetchInput,
  _ctx: ToolExecutionContext,
  maxBytes: number,
  referer: string,
): Promise<ToolResult> {
  const args: string[] = [
    "-s",                        // silent (no progress bar)
    "-L",                        // follow redirects
    "--max-time", String(CURL_TIMEOUT_S),
    "-A", BROWSER_UA,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
    "-H", "Accept-Language: zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "-H", "Cache-Control: no-cache",
    "-H", "Pragma: no-cache",
    "--compressed",              // accept gzip/br (curl decompresses for us)
    // Write HTTP status and content-type after the body
    "-w", `${CURL_META_SEP}%{http_code} %{content_type}`,
    // Output body to stdout
    "-o", "-",
  ];

  if (referer) args.push("-H", `Referer: ${referer}`);

  // Caller-provided headers
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }

  args.push(input.url);

  try {
    const { stdout } = await execFileAsync(CURL_BIN, args, {
      maxBuffer: 10_000_000,  // 10 MB — we truncate to maxBytes ourselves
      timeout: (CURL_TIMEOUT_S + 5) * 1000,
      encoding: "binary",  // raw bytes — we decode manually
    });

    // Parse metadata appended after CURL_META_SEP
    const sepIdx = stdout.lastIndexOf(CURL_META_SEP);
    const body    = sepIdx >= 0 ? stdout.slice(0, sepIdx) : stdout;
    const meta    = sepIdx >= 0 ? stdout.slice(sepIdx + CURL_META_SEP.length).trim() : "";

    const [httpStatus, ...ctParts] = meta.split(" ");
    const statusCode  = parseInt(httpStatus ?? "0", 10);
    const contentType = ctParts.join(" ");

    if (statusCode >= 400 || statusCode === 0) {
      const hint = statusCode >= 400 ? httpHint(statusCode, input.url) : "";
      return {
        content: `HTTP ${statusCode} — ${input.url}\n${hint}\n(via curl fallback)`,
        isError: true,
      };
    }

    // Convert binary string → Uint8Array for charset-aware decoding
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;

    const truncated = bytes.length > maxBytes;
    const slice = truncated ? bytes.slice(0, maxBytes) : bytes;

    const charset = extractCharset(contentType) ?? "utf-8";
    const raw = decode(slice, charset);

    return buildResult(input.url, contentType, raw, maxBytes, truncated, "(via curl fallback)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("web_fetch.curl_error", err);

    if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
      return {
        content: [
          `Request timed out after ${CURL_TIMEOUT_S}s: ${input.url}`,
          `Both native fetch and curl failed to connect.`,
          `Tip: Check proxy settings or ask the user to run the command manually.`,
        ].join("\n"),
        isError: true,
      };
    }

    return {
      content: `web_fetch (curl fallback) error: ${msg}`,
      isError: true,
    };
  }
}

// ── GitHub API handler ─────────────────────────────────────────────────────
//
// Handles api.github.com endpoints transparently:
//   - /repos/{owner}/{repo}           → repo metadata summary
//   - /repos/{owner}/{repo}/contents/{path} → file: decode base64, return source
//                                          → dir:  return file listing
//   - /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 → full tree listing
//   - Any other endpoint              → pretty-print JSON as-is
//
// Auto-injects Authorization header when githubToken is set.
// Falls back to curl when native fetch times out (same pattern as main path).

async function fetchGitHub(
  input: WebFetchInput,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const headers: Record<string, string> = {
    "User-Agent": "allycode/0.10.0",
    "Accept": "application/vnd.github.v3+json",
    ...(ctx.githubToken ? { "Authorization": `Bearer ${ctx.githubToken}` } : {}),
    ...(input.headers ?? {}),
  };

  logger.debug("web_fetch.github", { url: input.url, authed: !!ctx.githubToken });

  let body: string;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    if (ctx.signal) ctx.signal.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await fetch(input.url, { headers, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const hint = res.status === 403
          ? "GitHub API rate limit exceeded. Add github.token to ~/.allycode/settings.json (free, 5000 req/hr)."
          : res.status === 404
          ? "Repository or path not found. Check the URL is correct and the repo is public."
          : `HTTP ${res.status}`;
        return { content: `GitHub API error: ${hint}\n${text}`, isError: true };
      }
      body = await res.text();
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    // curl fallback for network issues
    try {
      const curlArgs = ["-sL", "--max-time", "15"];
      for (const [k, v] of Object.entries(headers)) curlArgs.push("-H", `${k}: ${v}`);
      curlArgs.push(input.url);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      const { stdout } = await execAsync(CURL_BIN, curlArgs, { maxBuffer: 4 * 1024 * 1024 });
      body = stdout;
    } catch (e2) {
      return { content: `GitHub fetch failed: ${String(err)}\ncurl also failed: ${String(e2)}`, isError: true };
    }
  }

  // Parse and render the response
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { content: body, isError: false }; }

  return renderGitHubResponse(input.url, parsed);
}

/** Render GitHub API JSON into human-readable plain text */
function renderGitHubResponse(url: string, data: unknown): ToolResult {
  // Directory listing: array of {name, type, size, sha, download_url}
  if (Array.isArray(data)) {
    const items = (data as Array<{ name: string; type: string; size?: number; sha: string }>);
    const dirs  = items.filter(i => i.type === "dir").map(i => `  📁 ${i.name}/`);
    const files = items.filter(i => i.type === "file").map(i => `  📄 ${i.name}  (${i.size ?? 0} bytes)`);
    const lines = [
      `GitHub directory: ${url}`,
      `${items.length} items (${dirs.length} dirs, ${files.length} files)`,
      "",
      ...dirs,
      ...files,
    ];
    return { content: lines.join("\n"), isError: false };
  }

  const obj = data as Record<string, unknown>;

  // Single file: has "content" field with base64 encoding
  if (obj["type"] === "file" && typeof obj["content"] === "string") {
    const decoded = Buffer.from(obj["content"] as string, "base64").toString("utf-8");
    const name    = String(obj["name"] ?? "file");
    const size    = String(obj["size"] ?? decoded.length);
    const sha     = String(obj["sha"] ?? "");
    const maxBytes = 80_000;
    const truncated = decoded.length > maxBytes;
    const content = truncated ? decoded.slice(0, maxBytes) : decoded;
    const suffix  = truncated ? `\n\n[File truncated at ${maxBytes} bytes — use maxBytes param or read by sections]` : "";
    return {
      content: `GitHub file: ${name}  (${size} bytes, sha: ${sha.slice(0, 8)})\n\n${content}${suffix}`,
      isError: false,
      metadata: { bytesRead: Math.min(decoded.length, maxBytes), truncated },
    };
  }

  // Repo metadata: has "full_name", "description", "stargazers_count" etc.
  if (typeof obj["full_name"] === "string") {
    const r = obj as Record<string, unknown>;
    const lines = [
      `Repository: ${r["full_name"]}`,
      `Description: ${r["description"] ?? "—"}`,
      `Stars: ${r["stargazers_count"]}  Forks: ${r["forks_count"]}  Watchers: ${r["subscribers_count"]}`,
      `Language: ${r["language"] ?? "—"}  License: ${(r["license"] as Record<string,unknown> | null)?.["name"] ?? "—"}`,
      `Default branch: ${r["default_branch"]}`,
      `Topics: ${(r["topics"] as string[] | undefined)?.join(", ") ?? "—"}`,
      `Created: ${r["created_at"]}  Updated: ${r["updated_at"]}`,
      `URL: ${r["html_url"]}`,
      "",
      `README / tree: ${r["html_url"]}/blob/${r["default_branch"]}/README.md`,
      `API contents: https://api.github.com/repos/${r["full_name"]}/contents/`,
      `API full tree: https://api.github.com/repos/${r["full_name"]}/git/trees/${r["default_branch"]}?recursive=1`,
    ];
    return { content: lines.join("\n"), isError: false };
  }

  // Git tree (recursive listing)
  if (obj["tree"] && Array.isArray(obj["tree"])) {
    const tree = obj["tree"] as Array<{ path: string; type: string; size?: number }>;
    const lines = [`GitHub tree: ${url}`, `${tree.length} entries`, ""];
    for (const node of tree) {
      const icon = node.type === "tree" ? "📁" : "📄";
      const size = node.size ? `  (${node.size}b)` : "";
      lines.push(`${icon} ${node.path}${size}`);
    }
    return { content: lines.join("\n"), isError: false };
  }

  // Default: pretty-print JSON
  return { content: `GitHub API response:\n\n${JSON.stringify(data, null, 2)}`, isError: false };
}

// ── Shared response builder ────────────────────────────────────────────────

function buildResult(
  url: string,
  contentType: string,
  raw: string,
  maxBytes: number,
  truncated: boolean,
  note = "",
): ToolResult {
  let text: string;
  let extractionNote = "";

  if (contentType.includes("application/json")) {
    try { text = JSON.stringify(JSON.parse(raw), null, 2); }
    catch { text = raw; }
  } else if (contentType.includes("text/html")) {
    const extracted = extractHtml(raw, url);
    text = extracted.text;
    extractionNote = extracted.note;
  } else {
    text = raw;
  }

  const suffix = truncated
    ? `\n\n[Content truncated at ${maxBytes} bytes — use maxBytes param to read more]`
    : "";

  const noteStr = [note, extractionNote].filter(Boolean).join("\n");
  const notePrefix = noteStr ? `\n${noteStr}` : "";

  return {
    content: `URL: ${url}\nContent-Type: ${contentType}${notePrefix}\n\n${text}${suffix}`,
    isError: false,
    metadata: { bytesRead: Math.min(raw.length, maxBytes), truncated },
  };
}

/**
 * Extract readable content from HTML using Mozilla Readability.
 * Falls back to enhanced stripHtml for pages Readability can't parse
 * (e.g. data tables, search result listings, API documentation pages).
 */
function extractHtml(html: string, url: string): { text: string; note: string } {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document, {
      // Keep more content for scientific pages that have dense structured data
      charThreshold: 20,
      // Preserve classes so table/code structure is retained
      keepClasses: false,
    });
    const article = reader.parse();

    if (article && article.textContent && article.textContent.trim().length > 200) {
      // Convert the parsed article DOM back to structured plain text
      const articleDom = new JSDOM(article.content ?? "");
      const doc = articleDom.window.document;
      const structured = domToText(doc.body);

      const title = article.title ? `# ${article.title}\n\n` : "";
      const byline = article.byline ? `Author: ${article.byline}\n\n` : "";
      const excerpt = article.excerpt
        ? `Summary: ${article.excerpt}\n\n---\n\n`
        : "---\n\n";

      return {
        text: `${title}${byline}${excerpt}${structured}`.trim(),
        note: `[Readability: extracted "${article.title ?? "article"}" — ads/nav/footer removed]`,
      };
    }
  } catch (err) {
    logger.debug("web_fetch.readability_failed", { url, err: String(err) });
  }

  // Fallback: enhanced regex stripper
  return { text: stripHtml(html), note: "[Readability: fallback mode — page not article-structured]" };
}

/**
 * Walk a DOM node tree and emit structured plain text.
 * Preserves headings, lists, tables, code blocks — important for scientific data.
 */
function domToText(node: Element | null): string {
  if (!node) return "";

  const lines: string[] = [];

  function walk(el: Element | ChildNode, depth = 0): void {
    if (el.nodeType === 3 /* TEXT_NODE */) {
      const t = (el as Text).textContent?.trim() ?? "";
      if (t) lines.push(t);
      return;
    }
    if (el.nodeType !== 1 /* ELEMENT_NODE */) return;

    const tag = (el as Element).tagName?.toLowerCase() ?? "";

    switch (tag) {
      case "h1": lines.push(`\n# ${(el as Element).textContent?.trim()}\n`); return;
      case "h2": lines.push(`\n## ${(el as Element).textContent?.trim()}\n`); return;
      case "h3": lines.push(`\n### ${(el as Element).textContent?.trim()}\n`); return;
      case "h4":
      case "h5":
      case "h6": lines.push(`\n#### ${(el as Element).textContent?.trim()}\n`); return;

      case "p": {
        const t = (el as Element).textContent?.trim();
        if (t) lines.push(`\n${t}\n`);
        return;
      }

      case "li": {
        const t = (el as Element).textContent?.trim();
        if (t) lines.push(`${"  ".repeat(depth)}- ${t}`);
        return;
      }

      case "ul":
      case "ol":
        lines.push("");
        for (const child of Array.from(el.childNodes)) walk(child, depth + 1);
        lines.push("");
        return;

      case "pre":
      case "code": {
        const t = (el as Element).textContent?.trim();
        if (t) lines.push(`\`\`\`\n${t}\n\`\`\``);
        return;
      }

      case "table": {
        lines.push("\n");
        lines.push(tableToText(el as Element));
        lines.push("\n");
        return;
      }

      case "br": lines.push(""); return;
      case "hr": lines.push("\n---\n"); return;

      case "script":
      case "style":
      case "noscript":
      case "iframe":
        return; // skip

      default:
        for (const child of Array.from(el.childNodes)) walk(child, depth);
    }
  }

  walk(node);
  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Render an HTML table as a markdown-style plain text table */
function tableToText(table: Element): string {
  const rows: string[][] = [];
  for (const row of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(row.querySelectorAll("th,td")).map(
      (c) => (c as Element).textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";

  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length), 3),
  );

  const fmt = (row: string[]) =>
    "| " + widths.map((w, i) => (row[i] ?? "").padEnd(w)).join(" | ") + " |";

  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";

  const out: string[] = [fmt(rows[0]!), sep];
  for (const row of rows.slice(1)) out.push(fmt(row));
  return out.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract charset from Content-Type header */
function extractCharset(contentType: string): string | null {
  const m = contentType.match(/charset=([^\s;]+)/i);
  if (!m) return null;
  const cs = m[1]!.toLowerCase().replace(/["']/g, "");
  if (cs === "gbk" || cs === "gb2312" || cs === "gb18030" || cs === "x-gbk") return "gbk";
  return cs;
}

/** Decode bytes with the given charset, falling back to UTF-8 */
function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Return a one-liner tip for common HTTP error codes */
function httpHint(status: number, url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (status === 403) return `Tip: ${host} is blocking automated access. Try a public API endpoint for this site instead.`;
  if (status === 401) return `Tip: This endpoint requires authentication. The user may need to provide an API key.`;
  if (status === 429) return `Tip: Rate limited by ${host}. Wait a moment or use an official API with a key.`;
  if (status === 404) return `Tip: URL not found. Check that the path is correct.`;
  if (status >= 500) return `Tip: Server error on ${host}. The service may be temporarily unavailable.`;
  return "";
}

/** Return a tip for common Node.js network error messages */
function networkTip(msg: string, url: string): string {
  const lc = msg.toLowerCase();
  if (lc.includes("econnrefused"))  return `Tip: Connection refused — the server is not accepting connections at ${url}`;
  if (lc.includes("enotfound"))     return `Tip: DNS resolution failed — check that the hostname is correct.`;
  if (lc.includes("econnreset"))    return `Tip: Connection reset — the server closed the connection unexpectedly.`;
  if (lc.includes("certificate"))   return `Tip: TLS certificate error — try the http:// variant if available.`;
  if (lc.includes("network"))       return `Tip: No network access from this process. Check firewall or proxy settings.`;
  return "Tip: If web_fetch keeps failing, try using bash with curl.exe as an alternative.";
}

/** Minimal HTML → plain-text stripper */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

function isMetadataEndpoint(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host === "metadata.google" ||
    host === "fd00:ec2::254" ||
    host.endsWith(".internal.metadata");
}
