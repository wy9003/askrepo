import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Chunk, EmbeddedChunk } from "./types.ts";

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

/**
 * In-process vector store with cosine similarity, persisted as JSON.
 * Deliberately hand-rolled: for demo-scale corpora (<100k chunks) exact
 * cosine search is instant, and keeping the math visible is the point.
 * The interface maps 1:1 onto Qdrant/pgvector if you outgrow it.
 */
export class VectorStore {
  private chunks: EmbeddedChunk[] = [];
  private norms: number[] = [];

  add(chunks: Chunk[], embeddings: number[][]): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(`chunk/embedding count mismatch: ${chunks.length} vs ${embeddings.length}`);
    }
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i]!;
      this.chunks.push({ ...chunks[i]!, embedding });
      this.norms.push(l2(embedding));
    }
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Return all unique indexed file paths. */
  files(): string[] {
    return [...new Set(this.chunks.map((c) => c.path))].sort();
  }

  search(query: number[], topK = 5): SearchHit[] {
    const qn = l2(query);
    return this.chunks
      .map((chunk, i) => ({ chunk, score: cosine(query, qn, chunk.embedding, this.norms[i]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ dim: this.chunks[0]?.embedding.length ?? 0, chunks: this.chunks }));
  }

  static async load(path: string): Promise<VectorStore> {
    const store = new VectorStore();
    const raw = JSON.parse(await readFile(path, "utf8")) as { chunks: EmbeddedChunk[] };
    store.chunks = raw.chunks;
    store.norms = raw.chunks.map((c) => l2(c.embedding));
    return store;
  }
}

function l2(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosine(a: number[], an: number, b: number[], bn: number): number {
  if (an === 0 || bn === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (an * bn);
}
