import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

/** Files we consider source/docs worth indexing. */
const ALLOWED_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sql", ".sh", ".html", ".css", ".scss",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".askrepo", ".venv", "venv", "__pycache__", ".next", ".turbo", "Pods", ".build",
]);

const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 5_000;

export interface ScannedFile {
  /** Repo-relative path, using forward slashes. */
  path: string;
  text: string;
}

export async function scanRepo(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".askrepo")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!ALLOWED_EXT.has(extname(entry.name))) continue;
        const st = await stat(full);
        if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
        const text = await readFile(full, "utf8").catch(() => null);
        // Skip files that decode to binary garbage.
        if (!text || text.includes("\u0000")) continue;
        files.push({ path: relative(root, full).split("\\").join("/"), text });
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
