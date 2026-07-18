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

/** Gather every rules source in the repo into one block for the manifest. */
export async function loadRules(root: string): Promise<LoadedRules> {
  const candidates = [...RULE_FILES];
  for (const glob of RULE_GLOBS) {
    candidates.push(...(await fg(glob, { cwd: root, dot: true }).catch(() => [])));
  }

  const parts: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const content = (await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "")).trim();
    if (!content) continue;
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
