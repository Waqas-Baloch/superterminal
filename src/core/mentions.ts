import { promises as fs } from "node:fs";
import nodePath from "node:path";
import fg from "fast-glob";

// Files the prompt names. Two jobs from one resolver:
//   1. If you mention a file that exists ("…using landing-page.md"), its
//      content is injected — so a context/brief/skill file works under any
//      name, not just the ones Glint knows by convention.
//   2. The session input highlights those names as you type, so you can see
//      Glint found the file before you hit enter.

const FILE_TOKEN = /\b([\w.-]+(?:\/[\w.-]+)*\.[a-zA-Z0-9]{1,6})\b/g;
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.glint/backup/**"];
const MAX_FILES = 3;
const MAX_CHARS = 6000;

export interface MentionedFile {
  path: string;
  content: string;
}

/** Filename-looking tokens in a prompt (existence is checked separately). */
export function extractFileMentions(task: string): string[] {
  return [...new Set([...task.matchAll(FILE_TOKEN)].map((m) => m[1]))];
}

/** Of those, the ones that actually exist — by path, or by basename anywhere. */
export async function resolveMentions(root: string, task: string): Promise<string[]> {
  const out: string[] = [];
  for (const token of extractFileMentions(task)) {
    if (out.length >= MAX_FILES) break;
    if (token.includes("/") && (await exists(nodePath.join(root, token)))) {
      out.push(token);
      continue;
    }
    const base = nodePath.basename(token);
    const hits = await fg(`**/${base}`, { cwd: root, ignore: IGNORE, dot: true, onlyFiles: true }).catch(() => []);
    if (hits.length > 0) out.push(hits[0]);
  }
  return [...new Set(out)];
}

export async function readMentioned(root: string, paths: string[]): Promise<MentionedFile[]> {
  const out: MentionedFile[] = [];
  for (const p of paths) {
    const raw = (await fs.readFile(nodePath.join(root, p), "utf8").catch(() => "")).trim();
    if (!raw) continue;
    out.push({ path: p, content: raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}\n…(truncated)` : raw });
  }
  return out;
}

export function renderMentionedSection(files: MentionedFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map((f) => `### ${f.path}\n${f.content}`);
  return `## Referenced files\nYou named these in the task — follow them.\n\n${blocks.join("\n\n")}`;
}

// Repo filenames, for highlighting as the user types. Cached per root: a full
// glob on every keystroke would be far too slow.
const fileCache = new Map<string, Set<string>>();

export async function repoFileNames(root: string, refresh = false): Promise<Set<string>> {
  if (!refresh) {
    const hit = fileCache.get(root);
    if (hit) return hit;
  }
  const files = await fg("**/*", { cwd: root, ignore: IGNORE, dot: true, onlyFiles: true }).catch(() => []);
  const set = new Set<string>();
  for (const f of files) {
    set.add(f);
    set.add(nodePath.basename(f));
  }
  fileCache.set(root, set);
  return set;
}

export function forgetFileNames(root: string): void {
  fileCache.delete(root);
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
