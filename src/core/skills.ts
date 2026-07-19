import { promises as fs } from "node:fs";
import nodePath from "node:path";
import fg from "fast-glob";
import { STOPWORDS } from "./selector";
import { ALL_STATE_DIRS } from "../util/paths";

// Skills — reusable know-how ("how we add an API endpoint", "how we write
// tests here") that should apply no matter which agent runs. Rules are always
// on; a skill is conditional: Glint matches it to the task and injects it only
// when it's relevant, so the manifest stays lean.
//
// Super Terminal reads its own <state>/skills/ AND Claude Code's .claude/skills/, so a
// team that already wrote skills for one agent gets them working with all of
// them without migrating anything.

export interface Skill {
  name: string;
  description: string; // when to use it
  triggers: string[]; // explicit keywords/phrases from frontmatter (optional)
  body: string; // the instructions themselves
  source: string; // repo-relative file it came from
}

const SKILL_GLOBS = [
  ...ALL_STATE_DIRS.flatMap((d) => [`${d}/skills/*/SKILL.md`, `${d}/skills/*.md`]),
  ".claude/skills/*/SKILL.md",
  ".claude/skills/*.md",
];
const MAX_SKILLS = 3; // never flood the manifest
const MAX_SKILL_CHARS = 4000;

export async function loadSkills(root: string): Promise<Skill[]> {
  const files = new Set<string>();
  for (const glob of SKILL_GLOBS) {
    for (const f of await fg(glob, { cwd: root, dot: true }).catch(() => [])) files.add(f);
  }

  const skills: Skill[] = [];
  for (const rel of [...files].sort()) {
    const raw = (await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "")).trim();
    if (!raw) continue;
    const { meta, body } = parseFrontmatter(raw);
    if (!body) continue;
    const fallbackName = nodePath.basename(nodePath.dirname(rel)) === "skills"
      ? nodePath.basename(rel).replace(/\.md$/i, "")
      : nodePath.basename(nodePath.dirname(rel));
    skills.push({
      name: meta.name || fallbackName,
      description: meta.description || "",
      triggers: splitList(meta.when ?? meta.triggers ?? ""),
      body,
      source: rel,
    });
  }
  return skills;
}

/**
 * Which skills apply to this task. Explicit `when:` triggers win; otherwise a
 * skill needs real word overlap with its name/description — one generic word
 * isn't enough, or every task would drag in every skill.
 */
export function matchSkills(task: string, skills: Skill[]): Skill[] {
  const lower = task.toLowerCase();
  const words = new Set(lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));

  const hit = skills.filter((s) => {
    if (s.triggers.length > 0) return s.triggers.some((t) => t && lower.includes(t.toLowerCase()));
    const sig = [...new Set(`${s.name} ${s.description}`.toLowerCase().split(/[^a-z0-9]+/))].filter(
      (w) => w.length >= 4 && !STOPWORDS.has(w),
    );
    if (sig.length === 0) return false;
    const overlap = sig.filter((w) => words.has(w)).length;
    return overlap >= Math.min(2, sig.length);
  });
  return hit.slice(0, MAX_SKILLS);
}

/** The manifest section (empty when no skill applies). */
export function renderSkillsSection(matched: Skill[]): string {
  if (matched.length === 0) return "";
  const blocks = matched.map((s) => {
    const body = s.body.length > MAX_SKILL_CHARS ? `${s.body.slice(0, MAX_SKILL_CHARS)}\n…(truncated)` : s.body;
    return `### Skill: ${s.name}${s.description ? ` — ${s.description}` : ""}\n(from ${s.source})\n\n${body}`;
  });
  return (
    `## Applicable skills\n` +
    `How this team does this kind of work. Follow it as written, whichever agent you are.\n\n${blocks.join("\n\n")}`
  );
}

function splitList(v: string): string[] {
  return v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Minimal `---` frontmatter reader — no YAML dependency for a few scalar keys. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}
