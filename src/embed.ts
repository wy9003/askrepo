/** Embedding providers. Both are dependency-free — plain fetch. */

export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const BATCH = 64;

export class OpenAIEmbedder implements Embedder {
  readonly dim = 1536; // text-embedding-3-small

  constructor(private apiKey: string, private model = "text-embedding-3-small") {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      lastErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
      // Retry on rate limits and server errors with simple backoff.
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw new Error(`OpenAI embeddings failed: ${lastErr}`);
  }
}

/**
 * Deterministic offline embedder: character-trigram hashing into a fixed
 * number of dimensions, L2-normalized. Not semantic — good enough to test
 * the retrieval pipeline and to demo without an API key.
 */
export class MockEmbedder implements Embedder {
  readonly dim: number;

  constructor(dim = 256) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t.toLowerCase()));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const padded = ` ${text} `;
    for (let i = 0; i < padded.length - 2; i++) {
      const gram = padded.slice(i, i + 3);
      const idx = hash(gram) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
