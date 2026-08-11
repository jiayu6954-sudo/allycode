/**
 * I012: Embedding Provider
 *
 * 为语义记忆检索提供向量化能力。
 *
 * 两种模式（自动降级）：
 *   1. Ollama 本地 Embedding 模型（零成本，高质量）
 *      - 默认模型：nomic-embed-text（768维，速度极快）
 *      - 备选：mxbai-embed-large（1024维，更高质量）
 *   2. TF-IDF 关键词向量（无需任何模型，纯算法）
 *      - 当 Ollama 不可用时自动启用
 *      - 维度动态，基于词频统计
 *
 * 创新点：本地 embedding 意味着记忆向量化完全离线，无 API 调用，无成本。
 */

import { logger } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmbeddingVector = number[];

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
  readonly dims: number;
  readonly mode: "ollama" | "tfidf";
}

// ── Ollama embedding provider ─────────────────────────────────────────────────

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings";
const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "ollama" as const;
  private _dims = 0;

  constructor(
    private model = DEFAULT_EMBED_MODEL,
    private baseUrl = OLLAMA_EMBED_URL,
  ) {}

  get dims(): number { return this._dims || 768; }

  async embed(text: string): Promise<EmbeddingVector> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
    const json = await res.json() as { embedding: number[] };
    const vec = json.embedding;
    if (!this._dims) this._dims = vec.length;
    return vec;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    // Ollama doesn't have native batch — parallelise with limited concurrency
    const CONCURRENCY = 4;
    const results: EmbeddingVector[] = [];
    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts.slice(i, i + CONCURRENCY);
      const vecs = await Promise.all(batch.map((t) => this.embed(t)));
      results.push(...vecs);
    }
    return results;
  }

  /** Check if Ollama embedding endpoint is available */
  static async isAvailable(model = DEFAULT_EMBED_MODEL): Promise<boolean> {
    try {
      const res = await fetch(OLLAMA_EMBED_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "test" }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── TF-IDF fallback embedding provider ───────────────────────────────────────

/**
 * TF-IDF based sparse vector embedding.
 * No model required — works completely offline without any external service.
 *
 * How it works:
 *   - Maintains a vocabulary built from all texts it has seen
 *   - Each text becomes a sparse TF-IDF vector
 *   - Cosine similarity between TF-IDF vectors approximates semantic similarity
 *     for keyword-heavy technical text (code, error messages, file paths)
 */
export class TfIdfEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "tfidf" as const;

  private vocabulary = new Map<string, number>(); // word → index
  private docFreq = new Map<string, number>();     // word → # docs containing it
  private totalDocs = 0;

  get dims(): number { return Math.max(this.vocabulary.size, 256); }

  async embed(text: string): Promise<EmbeddingVector> {
    const tokens = tokenize(text);
    this.updateVocabulary(tokens);
    return this.toVector(tokens);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    // First pass: build vocabulary from all texts
    const tokenLists = texts.map(tokenize);
    for (const tokens of tokenLists) this.updateVocabulary(tokens);
    // Second pass: vectorise with stable vocabulary
    return tokenLists.map((tokens) => this.toVector(tokens));
  }

  private updateVocabulary(tokens: string[]): void {
    const seen = new Set(tokens);
    this.totalDocs++;
    for (const word of seen) {
      if (!this.vocabulary.has(word)) {
        this.vocabulary.set(word, this.vocabulary.size);
      }
      this.docFreq.set(word, (this.docFreq.get(word) ?? 0) + 1);
    }
  }

  private toVector(tokens: string[]): EmbeddingVector {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const size = this.vocabulary.size;
    const vec = new Array<number>(size).fill(0);

    for (const [word, count] of tf) {
      const idx = this.vocabulary.get(word);
      if (idx === undefined) continue;
      const tfScore = count / tokens.length;
      const df = this.docFreq.get(word) ?? 1;
      const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
      vec[idx] = tfScore * idf;
    }

    return normalise(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")  // keep Chinese chars
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 30)
    .slice(0, 512); // cap for performance
}

function normalise(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the best available embedding provider.
 * Tries Ollama first, falls back to TF-IDF.
 */
export async function createEmbeddingProvider(
  ollamaModel = DEFAULT_EMBED_MODEL
): Promise<EmbeddingProvider> {
  const ollamaAvailable = await OllamaEmbeddingProvider.isAvailable(ollamaModel);
  if (ollamaAvailable) {
    logger.debug("embeddings.using_ollama", { model: ollamaModel });
    return new OllamaEmbeddingProvider(ollamaModel);
  }
  logger.debug("embeddings.using_tfidf_fallback");
  return new TfIdfEmbeddingProvider();
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
