import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { GlintConfig } from "../util/config";

export interface IndexedFile {
  path: string; // repo-relative, posix separators
  size: number;
  lines: number;
  hash: string;
  ext: string;
  mtimeMs: number; // last-modified time — proxy for recency ranking signal
}

export interface RepoIndex {
  root: string;
  createdAt: string;
  files: IndexedFile[];
}

const CODE_GLOBS = [
  "**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.{html,htm}",
  "**/*.{json,md,mdx}",
  "**/*.{css,scss}",
  "**/*.{prisma,graphql,gql}",
  "**/*.{yml,yaml}",
  "**/.env.example",
];

const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/coverage/**",
  "**/.glint/**",
  "**/.squash/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/*.min.js",
  "**/*.map",
];

const MAX_FILE_BYTES = 512 * 1024;

export async function indexRepo(root: string, config: GlintConfig): Promise<RepoIndex> {
  const entries = await fg([...CODE_GLOBS, ...config.include], {
    cwd: root,
    ignore: [...ALWAYS_EXCLUDE, ...config.exclude],
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });

  const gitignoreFilter = await loadGitignore(root);
  const kept = gitignoreFilter ? entries.filter((p) => !gitignoreFilter.ignores(p)) : entries;

  const files: IndexedFile[] = [];
  for (const rel of kept.sort()) {
    const abs = path.join(root, rel);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) continue;
    const content = await fs.readFile(abs);
    files.push({
      path: rel,
      size: stat.size,
      lines: countLines(content),
      hash: createHash("sha1").update(content).digest("hex"),
      ext: path.extname(rel),
      mtimeMs: stat.mtimeMs,
    });
  }

  const index: RepoIndex = { root, createdAt: new Date().toISOString(), files };
  await writeCache(root, index);
  return index;
}

async function loadGitignore(root: string) {
  try {
    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    return ignore().add(content);
  } catch {
    return null;
  }
}

function countLines(buf: Buffer): number {
  let lines = 1;
  for (const byte of buf) if (byte === 0x0a) lines++;
  return lines;
}

async function writeCache(root: string, index: RepoIndex): Promise<void> {
  const dir = path.join(root, ".glint");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
}
