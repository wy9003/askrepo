import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmbedder } from "../src/embed.ts";
import { VectorStore } from "../src/store.ts";
import type { Chunk } from "../src/types.ts";

const embedder = new MockEmbedder();

function chunk(path: string, text: string): Chunk {
  return { path, startLine: 1, endLine: 3, text };
}

test("cosine search ranks the matching chunk first", async () => {
  const store = new VectorStore();
  const chunks = [
    chunk("auth.ts", "function login(user, password) { verify credentials }"),
    chunk("store.ts", "class VectorStore { cosine similarity search }"),
    chunk("readme.md", "welcome to the project documentation"),
  ];
  store.add(chunks, await embedder.embed(chunks.map((c) => c.text)));

  const [q] = await embedder.embed(["cosine similarity search"]);
  const hits = store.search(q!, 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.chunk.path, "store.ts");
  assert.ok(hits[0]!.score > hits[1]!.score);
});

test("files() lists unique indexed paths", async () => {
  const store = new VectorStore();
  const chunks = [chunk("a.ts", "one"), chunk("a.ts", "two"), chunk("b.ts", "three")];
  store.add(chunks, await embedder.embed(chunks.map((c) => c.text)));
  assert.deepEqual(store.files(), ["a.ts", "b.ts"]);
  assert.equal(store.size, 3);
});

test("save/load roundtrip preserves chunks and search behaviour", async () => {
  const dir = await mkdtemp(join(tmpdir(), "askrepo-"));
  try {
    const store = new VectorStore();
    const chunks = [chunk("x.ts", "hello agent loop tool calls"), chunk("y.ts", "unrelated content here")];
    store.add(chunks, await embedder.embed(chunks.map((c) => c.text)));
    const file = join(dir, "index.json");
    await store.save(file);

    const loaded = await VectorStore.load(file);
    assert.equal(loaded.size, 2);
    const [q] = await embedder.embed(["agent loop tool calls"]);
    const hits = loaded.search(q!, 1);
    assert.equal(hits[0]!.chunk.path, "x.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
