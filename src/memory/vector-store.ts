import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingProvider, EmbeddingVector } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import { MEMORY_DIR } from "../config/settings.js";
import { logger } from "../utils/logger.js";

const VECTOR_STORE_PATH = path.join(MEMORY_DIR, "vectors.json");
const STORE_VERSION = 2;
const MAX_CHUNK_CHARS = 300;
const MIN_CHUNK_CHARS = 20;
export const GLOBAL_MEMORY_PROJECT_ID = "__global__";

export type MemoryLayer = "user" | "context" | "decisions" | "learnings";

export interface VectorChunk {
  id: string;
  projectId: string;
  layer: MemoryLayer;
  text: string;
  vector: EmbeddingVector;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  chunk: VectorChunk;
  score: number;
}

interface StorageFormat {
  version: number;
  embeddingModel: string;
  chunks: VectorChunk[];
}

export class VectorStore {
  private chunks: VectorChunk[] = [];
  private embeddingModel = "unknown";
  private dirty = false;

  constructor(private storePath = VECTOR_STORE_PATH) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(
        await fs.readFile(this.storePath, "utf-8"),
      ) as Partial<StorageFormat>;
      if (data.version !== STORE_VERSION) {
        this.chunks = [];
        this.dirty = true;
        logger.info("vector_store.rebuild_required", {
          stored: data.version,
          current: STORE_VERSION,
        });
        return;
      }
      this.chunks = Array.isArray(data.chunks) ? data.chunks : [];
      this.embeddingModel = data.embeddingModel ?? "unknown";
    } catch {
      this.chunks = [];
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const data: StorageFormat = {
      version: STORE_VERSION,
      embeddingModel: this.embeddingModel,
      chunks: this.chunks,
    };
    const temporaryPath = `${this.storePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(data), "utf-8");
    await fs.rename(temporaryPath, this.storePath);
    this.dirty = false;
  }

  clear(): void {
    if (this.chunks.length === 0) return;
    this.chunks = [];
    this.dirty = true;
  }

  async upsertMemoryLayer(
    projectId: string,
    layer: MemoryLayer,
    text: string,
    embedder: EmbeddingProvider,
    force = false,
  ): Promise<boolean> {
    const normalized = text.trim();
    if (!normalized) return false;
    const contentHash = sha256(normalized);
    const existing = this.chunks.filter(
      (chunk) => chunk.projectId === projectId && chunk.layer === layer,
    );
    if (
      !force &&
      existing.length > 0 &&
      existing.every((chunk) => chunk.contentHash === contentHash)
    ) {
      return false;
    }

    const chunkTexts = chunkText(normalized);
    const vectors = await embedder.embedBatch(chunkTexts);
    const now = Date.now();
    const createdAt = existing[0]?.createdAt ?? now;
    this.chunks = this.chunks.filter(
      (chunk) => !(chunk.projectId === projectId && chunk.layer === layer),
    );
    for (let index = 0; index < chunkTexts.length; index++) {
      this.chunks.push({
        id: makeChunkId(projectId, layer, index, contentHash),
        projectId,
        layer,
        text: chunkTexts[index]!,
        vector: vectors[index]!,
        contentHash,
        createdAt,
        updatedAt: now,
      });
    }
    this.embeddingModel = embedder.mode;
    this.dirty = true;
    return true;
  }

  search(
    queryVector: EmbeddingVector,
    projectId: string,
    topK = 8,
    threshold = 0.25,
  ): SearchResult[] {
    return this.chunks
      .filter((chunk) =>
        chunk.projectId === projectId ||
        (chunk.projectId === GLOBAL_MEMORY_PROJECT_ID && chunk.layer === "user")
      )
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
      .filter((result) => result.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  stats(): { total: number; byLayer: Record<string, number>; projects: number } {
    const byLayer: Record<string, number> = {};
    const projects = new Set<string>();
    for (const chunk of this.chunks) {
      byLayer[chunk.layer] = (byLayer[chunk.layer] ?? 0) + 1;
      projects.add(chunk.projectId);
    }
    return { total: this.chunks.length, byLayer, projects: projects.size };
  }

  pruneStale(maxAgeMs = 90 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((chunk) =>
      chunk.projectId === GLOBAL_MEMORY_PROJECT_ID || chunk.updatedAt > cutoff
    );
    const pruned = before - this.chunks.length;
    if (pruned > 0) this.dirty = true;
    return pruned;
  }
}

function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= MIN_CHUNK_CHARS);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      chunks.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?。！？])\s+/);
    let current = "";
    for (const sentence of sentences) {
      if (
        current.length + sentence.length > MAX_CHUNK_CHARS &&
        current.length >= MIN_CHUNK_CHARS
      ) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current.length >= MIN_CHUNK_CHARS) chunks.push(current.trim());
  }
  if (chunks.length === 0 && text.trim()) chunks.push(text.slice(0, MAX_CHUNK_CHARS));
  return chunks;
}

function makeChunkId(
  projectId: string,
  layer: string,
  index: number,
  contentHash: string,
): string {
  return `${projectId}_${layer}_${index}_${contentHash.slice(0, 8)}`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
