import path from "node:path";
import type { LongTermMemory } from "./long-term.js";
import { loadLongTermMemory } from "./long-term.js";
import {
  GLOBAL_MEMORY_PROJECT_ID,
  VectorStore,
  type MemoryLayer,
} from "./vector-store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { logger } from "../utils/logger.js";
import { stableProjectFingerprint } from "../storage/agent-database.js";

export interface SemanticRetrievalConfig {
  topK: number;
  threshold: number;
  embeddingModel: string;
  reindexOnChange: boolean;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticRetrievalConfig = {
  topK: 8,
  threshold: 0.25,
  embeddingModel: "nomic-embed-text",
  reindexOnChange: true,
};

export class SemanticMemoryRetriever {
  private store: VectorStore;
  private embedder: EmbeddingProvider | null = null;
  private initialized = false;

  constructor(private config: SemanticRetrievalConfig = DEFAULT_SEMANTIC_CONFIG) {
    this.store = new VectorStore();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.load();
    this.embedder = await createEmbeddingProvider(this.config.embeddingModel);
    // TF-IDF vocabulary is process-local. Persisted vectors cannot safely be reused
    // after restart because their dimensions no longer map to the same terms.
    if (this.embedder.mode === "tfidf") this.store.clear();
    this.initialized = true;
  }

  async indexProjectMemory(
    projectPath: string,
    memory: LongTermMemory,
  ): Promise<void> {
    await this.ensureInit();
    const projectId = projectFingerprint(projectPath);
    const layers: Array<{ projectId: string; layer: MemoryLayer; text: string }> = [
      { projectId: GLOBAL_MEMORY_PROJECT_ID, layer: "user", text: memory.user },
      { projectId, layer: "context", text: memory.projectContext },
      { projectId, layer: "decisions", text: memory.projectDecisions },
      { projectId, layer: "learnings", text: memory.projectLearnings },
    ];

    let changed = false;
    for (const item of layers) {
      if (!item.text.trim()) continue;
      changed = await this.store.upsertMemoryLayer(
        item.projectId,
        item.layer,
        item.text,
        this.embedder!,
        !this.config.reindexOnChange || this.embedder!.mode === "tfidf",
      ) || changed;
    }
    if (this.store.pruneStale() > 0) changed = true;
    if (changed) await this.store.save();
  }

  async retrieveRelevant(
    projectPath: string,
    userMessage: string,
  ): Promise<string | null> {
    await this.ensureInit();
    let queryVector: number[];
    try {
      queryVector = await this.embedder!.embed(userMessage);
    } catch (err) {
      logger.warn("semantic_retrieval.embed_failed", err);
      return null;
    }

    const results = this.store.search(
      queryVector,
      projectFingerprint(projectPath),
      this.config.topK,
      this.config.threshold,
    );
    if (results.length === 0) return null;

    const byLayer = new Map<MemoryLayer, string[]>();
    for (const { chunk } of results) {
      const values = byLayer.get(chunk.layer) ?? [];
      values.push(chunk.text);
      byLayer.set(chunk.layer, values);
    }
    const labels: Record<MemoryLayer, string> = {
      user: "About this user",
      context: "Project overview",
      decisions: "Key technical decisions",
      learnings: "What we have learned",
    };
    const sections = [...byLayer.entries()].map(
      ([layer, texts]) => `### ${labels[layer]}\n${texts.join("\n")}`,
    );
    return `## Relevant memory — ${path.basename(projectPath)}\n\n${sections.join("\n\n")}`;
  }

  getStats(): { total: number; byLayer: Record<string, number>; projects: number; mode: string } {
    return { ...this.store.stats(), mode: this.embedder?.mode ?? "not initialized" };
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init();
  }
}

let retriever: SemanticMemoryRetriever | null = null;
let retrieverKey = "";

export function getSemanticRetriever(
  config?: Partial<SemanticRetrievalConfig>,
): SemanticMemoryRetriever {
  const resolved = { ...DEFAULT_SEMANTIC_CONFIG, ...config };
  const key = JSON.stringify(resolved);
  if (!retriever || retrieverKey !== key) {
    retriever = new SemanticMemoryRetriever(resolved);
    retrieverKey = key;
  }
  return retriever;
}

function projectFingerprint(projectPath: string): string {
  return stableProjectFingerprint(projectPath);
}

export async function buildMemorySection(
  projectPath: string,
  userMessage: string,
  config?: Partial<SemanticRetrievalConfig>,
): Promise<string | null> {
  try {
    const memory = await loadLongTermMemory(projectPath);
    if (
      !memory.user &&
      !memory.projectContext &&
      !memory.projectDecisions &&
      !memory.projectLearnings
    ) {
      return null;
    }
    const currentRetriever = getSemanticRetriever(config);
    await currentRetriever.init();
    await currentRetriever.indexProjectMemory(projectPath, memory);
    return currentRetriever.retrieveRelevant(projectPath, userMessage);
  } catch (err) {
    logger.warn("semantic_retrieval.build_section_failed", err);
    return null;
  }
}
