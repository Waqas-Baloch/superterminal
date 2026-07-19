import { promises as fs } from "node:fs";
import nodePath from "node:path";
import fg from "fast-glob";

// Project rules — the heart of the neutral layer. Teams already keep AI
// instructions in files like CLAUDE.md, .cursorrules, or AGENTS.md, each tied
// to one agent. Glint reads them ALL and applies them to whichever agent runs,
// so a rule written once holds across Claude Code, Cursor, and Codex. Plus an
// optional Glint-native file (.glint/rules.md) for anything agent-agnostic.

export interface LoadedRules {
  text: string; // combined rules to inject into the manifest
  sources: string[]; // repo-relative files that contributed (for display)
}

const MAX_RULES_CHARS = 8000; // keep the manifest lean (~2k tokens)

// Known instruction files, in priority order. Glint-native first, then the
// per-agent files teams may already have.
const RULE_FILES = [
  ".glint/rules.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];
const RULE_GLOBS = [".cursor/rules/*.md", ".cursor/rules/*.mdc"];

// Project context — what the project *is*, as opposed to rules, which
// constrain what an agent may do. Always injected when present, for every agent.
const CONTEXT_FILES = [".glint/context.md", "context.md", "CONTEXT.md", "docs/context.md", "PROJECT.md"];

export async function loadContext(root: string): Promise<LoadedRules> {
  return readAll(root, CONTEXT_FILES);
}

export function renderContextSection(ctx: LoadedRules): string {
  if (!ctx.text) return "";
  return (
    `## Project context\n` +
    `What this project is and how it works. Treat it as background for every decision, ` +
    `whichever agent you are (from ${ctx.sources.join(", ")}).\n\n${ctx.text}`
  );
}

/** Gather every rules source in the repo into one block for the manifest. */
export async function loadRules(root: string): Promise<LoadedRules> {
  const candidates = [...RULE_FILES];
  for (const glob of RULE_GLOBS) {
    candidates.push(...(await fg(glob, { cwd: root, dot: true }).catch(() => [])));
  }
  return readAll(root, candidates);
}

async function readAll(root: string, candidates: string[]): Promise<LoadedRules> {
  const parts: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  // macOS and Windows are case-insensitive, so `context.md` and `CONTEXT.md`
  // are one file read twice. Dedupe on content, not just on the name, or the
  // same instructions land in the manifest twice.
  const seenContent = new Set<string>();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const content = (await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "")).trim();
    if (!content || seenContent.has(content)) continue;
    seenContent.add(content);
    sources.push(rel);
    parts.push(`### From ${rel}\n${content}`);
  }

  let text = parts.join("\n\n");
  if (text.length > MAX_RULES_CHARS) text = `${text.slice(0, MAX_RULES_CHARS)}\n…(rules truncated)`;
  return { text, sources };
}

/** The manifest section (empty string when the repo has no rules). */
export function renderRulesSection(rules: LoadedRules): string {
  if (!rules.text) return "";
  return (
    `## Project rules\n` +
    `Follow these rules for this repository — they apply no matter which agent you are ` +
    `(sourced from ${rules.sources.join(", ")}).\n\n${rules.text}`
  );
}

// The "keeps them honest" half: not every rule is machine-checkable, but the
// most common and highest-value one is — "don't touch these paths". We extract
// those from any rules text and verify them after the run, regardless of which
// agent ran. Free-text convention → deterministic check.
const PROTECT_RE = /\b(do ?n['o]?t|never|avoid|don't)\b[^.\n]*\b(edit|modif|touch|chang|alter|writ|delet|updat)/i;

/** Paths the rules say must not be modified (e.g. `dist/`, `/payments`, `src/generated`). */
export function extractProtectedPaths(rulesText: string): string[] {
  const out = new Set<string>();
  for (const line of rulesText.split("\n")) {
    if (!PROTECT_RE.test(line)) continue;
    for (const tok of pathTokens(line)) out.add(tok);
  }
  return [...out];
}

function pathTokens(line: string): string[] {
  const raw = new Set<string>();
  for (const m of line.matchAll(/`([^`]+)`/g)) raw.add(m[1]); // backticked
  for (const m of line.matchAll(/[A-Za-z0-9_.@-]*\/[A-Za-z0-9_./*-]*/g)) raw.add(m[0]); // has a slash
  const out: string[] = [];
  for (const t of raw) {
    const norm = t
      .trim()
      .replace(/^\.?\//, "") // leading ./ or /
      .replace(/[*]+$/, "")
      .replace(/\/+$/, "")
      .replace(/[.,;:)]+$/, "");
    if (norm && !norm.includes(" ") && /[A-Za-z0-9_]/.test(norm) && norm.length >= 2) out.push(norm);
  }
  return out;
}

/** Does a changed file fall under a protected path? Returns the matched rule path, or null. */
export function protectedMatch(file: string, protectedPaths: string[]): string | null {
  const f = file.replace(/^\.?\//, "");
  for (const p of protectedPaths) {
    if (f === p || f.startsWith(`${p}/`)) return p;
    if (!p.includes("/") && f.split("/").includes(p)) return p; // a bare dir name, matched anywhere
  }
  return null;
}
