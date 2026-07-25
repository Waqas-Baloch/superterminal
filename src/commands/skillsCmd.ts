import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import fg from "fast-glob";
import { STATE_DIR } from "../util/paths";
import { log } from "../util/logger";

// `super-t skills sync|import` — make .super-t/skills/ the source of truth.
//
// Runtime injection already gives every agent the skills when they run THROUGH
// Super Terminal. Sync makes them work when a teammate runs a vendor CLI
// directly: skills are materialized into Claude Code's native folder, and
// listed in AGENTS.md — the file Codex and Cursor read natively. Import pulls
// existing vendor skills into the neutral store, so adopting Super Terminal
// doesn't mean rewriting anything.

const MARK_START = "<!-- super-t:skills:start -->";
const MARK_END = "<!-- super-t:skills:end -->";

interface SkillFile {
  name: string; // folder or file basename
  rel: string; // repo-relative source path
  content: string;
}

async function readNeutralSkills(root: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const dirSkills = await fg(`${STATE_DIR}/skills/*/SKILL.md`, { cwd: root, dot: true }).catch(() => []);
  for (const rel of dirSkills) {
    out.push({ name: nodePath.basename(nodePath.dirname(rel)), rel, content: await fs.readFile(nodePath.join(root, rel), "utf8") });
  }
  const flat = await fg(`${STATE_DIR}/skills/*.md`, { cwd: root, dot: true }).catch(() => []);
  for (const rel of flat) {
    if (rel.endsWith("/SKILL.md")) continue;
    out.push({ name: nodePath.basename(rel, ".md"), rel, content: await fs.readFile(nodePath.join(root, rel), "utf8") });
  }
  return out;
}

/** Write/replace the marked skills section in AGENTS.md (Codex and Cursor read it natively). */
export function upsertAgentsSection(existing: string, skills: SkillFile[]): string {
  const lines = skills.map((s) => `- **${s.name}** — see \`${s.rel}\``);
  const section = `${MARK_START}\n## Skills\nProject skills every agent should apply when relevant:\n${lines.join("\n")}\n${MARK_END}`;
  if (existing.includes(MARK_START) && existing.includes(MARK_END)) {
    const start = existing.indexOf(MARK_START);
    const end = existing.indexOf(MARK_END) + MARK_END.length;
    return existing.slice(0, start) + section + existing.slice(end);
  }
  return existing.trim() ? `${existing.trimEnd()}\n\n${section}\n` : `# Agent instructions\n\n${section}\n`;
}

export async function skillsCommand(action?: string): Promise<void> {
  const root = process.cwd();
  const verb = (action ?? "").toLowerCase();

  if (verb === "sync") {
    const skills = await readNeutralSkills(root);
    if (skills.length === 0) {
      log.info(`No skills found in ${STATE_DIR}/skills/ — add one as ${STATE_DIR}/skills/<name>/SKILL.md.`);
      return;
    }
    // Claude Code native folder
    for (const s of skills) {
      const dest = nodePath.join(root, ".claude", "skills", s.name, "SKILL.md");
      await fs.mkdir(nodePath.dirname(dest), { recursive: true });
      await fs.writeFile(dest, s.content);
    }
    // AGENTS.md section (Codex + Cursor read AGENTS.md natively)
    const agentsPath = nodePath.join(root, "AGENTS.md");
    const existing = await fs.readFile(agentsPath, "utf8").catch(() => "");
    await fs.writeFile(agentsPath, upsertAgentsSection(existing, skills));
    log.success(`Synced ${skills.length} skill(s) → .claude/skills/ and AGENTS.md.`);
    log.dim("  They now apply even when someone runs a vendor CLI directly. Commit both to share.");
    return;
  }

  if (verb === "import") {
    const found = await fg(".claude/skills/*/SKILL.md", { cwd: root, dot: true }).catch(() => []);
    let imported = 0;
    for (const rel of found) {
      const name = nodePath.basename(nodePath.dirname(rel));
      const dest = nodePath.join(root, STATE_DIR, "skills", name, "SKILL.md");
      const exists = await fs
        .access(dest)
        .then(() => true)
        .catch(() => false);
      if (exists) continue; // never clobber the neutral copy
      await fs.mkdir(nodePath.dirname(dest), { recursive: true });
      await fs.copyFile(nodePath.join(root, rel), dest);
      imported++;
    }
    log.success(`Imported ${imported} skill(s) into ${STATE_DIR}/skills/ (${found.length - imported} already there).`);
    if (imported > 0) log.dim("  Run `super-t skills sync` after editing to push them back out.");
    return;
  }

  log.info(pc.bold("super-t skills <sync|import>"));
  log.info(`  sync    materialize ${STATE_DIR}/skills/ into .claude/skills/ + AGENTS.md`);
  log.info(`  import  copy existing .claude/skills/ into ${STATE_DIR}/skills/`);
}
