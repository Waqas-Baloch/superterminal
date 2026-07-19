import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import { loadRules } from "../core/rules";
import { log } from "../util/logger";
import { stateDir, STATE_DIR, findStateFile } from "../util/paths";

// Directories that usually hold generated/vendored output — worth protecting
// by default so an agent regenerates from source instead of hand-editing them.
const CANDIDATE_GENERATED = ["dist", "build", "generated", ".next", "out", "coverage", "vendor"];

/**
 * `super-t init` — make the neutral layer effortless. Super Terminal already reads any
 * existing agent instruction files; this just drafts a starter <state>/rules.md
 * from what it detects, so a team gets useful, editable rules without staring
 * at a blank file. Nothing here is required — it's a convenience.
 */
export async function initCommand(): Promise<void> {
  const root = process.cwd();
  const rulesPath = nodePath.join(stateDir(root), "rules.md");

  // Rule files already applied across every agent.
  const existing = (await loadRules(root)).sources.filter((s) => !s.endsWith("/rules.md"));
  if (existing.length > 0) {
    log.info(`Super Terminal already reads ${pc.bold(existing.join(", "))} — those rules now apply to every agent.`);
    log.info("");
  }

  if (await exists(rulesPath)) {
    log.info(`${pc.bold(`${STATE_DIR}/rules.md`)} already exists — edit it to change your rules.`);
    return;
  }

  // A rules file from an earlier brand is still read, so writing a second one
  // would leave two live rule files with no indication which is in effect.
  const legacy = await findStateFile(root, "rules.md");
  if (legacy) {
    const rel = nodePath.relative(root, legacy);
    log.info(`${pc.bold(rel)} already exists and is still applied to every agent.`);
    log.dim(`  To adopt the current location, move it: mv ${rel} ${STATE_DIR}/rules.md`);
    return;
  }

  const pkg = await readJson(nodePath.join(root, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const testCmd = hasRealScript(scripts, "test") ? "npm test" : "";
  const generated: string[] = [];
  for (const d of CANDIDATE_GENERATED) if (await exists(nodePath.join(root, d))) generated.push(`${d}/`);

  const draft = [
    "# Super Terminal project rules",
    "Plain-English rules Super Terminal applies to every AI agent (Claude Code, Cursor, Codex) in this repo.",
    "Edit freely — anything here is enforced across all of them.",
    "",
    "## Guardrails",
    generated.length > 0
      ? `- Do not modify generated code: ${generated.join(", ")} — change the source that produces it instead.`
      : "- Do not modify generated or vendored code — change the source that produces it instead.",
    testCmd
      ? `- Run \`${testCmd}\` and make sure it passes before finishing.`
      : "- Run the project's tests and make sure they pass before finishing.",
    "- Make the smallest change that fully satisfies the task; don't refactor or reformat unrelated code.",
    "",
    "## Conventions",
    "- (add your team's naming, structure, or style conventions here)",
    "",
  ].join("\n");

  await fs.mkdir(nodePath.dirname(rulesPath), { recursive: true });
  await fs.writeFile(rulesPath, draft);
  log.success(`Created ${pc.bold(`${STATE_DIR}/rules.md`)} — a starter draft from what Super Terminal detected in your project.`);
  log.dim("Commit it to share with your team. Super Terminal applies it to whichever agent runs — and verifies it too.");
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function hasRealScript(scripts: Record<string, string>, name: string): boolean {
  const v = scripts[name];
  return Boolean(v) && !/no test specified/i.test(v);
}
