import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.ts";

test("scanner filters extensions, skip-dirs, and binaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "askrepo-scan-"));
  try {
    await writeFile(join(dir, "main.ts"), "export {};\n");
    await writeFile(join(dir, "notes.md"), "# notes\n");
    await writeFile(join(dir, "image.png"), "\u0000PNG");
    await writeFile(join(dir, "binary.ts"), "\u0000bad");
    await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "util.py"), "def f():\n    pass\n");

    const files = await scanRepo(dir);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["main.ts", "notes.md", "src/util.py"]);
    assert.ok(files.find((f) => f.path === "src/util.py")!.text.includes("def f"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanner returns empty for a directory with no indexable files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "askrepo-empty-"));
  try {
    await writeFile(join(dir, "logo.svg"), "<svg/>");
    assert.deepEqual(await scanRepo(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
