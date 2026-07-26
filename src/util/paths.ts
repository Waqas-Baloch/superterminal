import { promises as fs } from "node:fs";
import nodePath from "node:path";
import os from "node:os";

// Where Super Terminal keeps its state. One name, no legacy fallbacks — the
// pre-rename builds had no real users, so nothing needs migrating.

export const STATE_DIR = ".super-t";

/** Keeps the state directory out of the repo index. */
export const STATE_IGNORE_GLOBS = [`**/${STATE_DIR}/**`];

/** The project's state directory. */
export function stateDir(root: string): string {
  return nodePath.join(root, STATE_DIR);
}

/** A file inside the project's state directory. */
export function statePath(root: string, ...rel: string[]): string {
  return nodePath.join(root, STATE_DIR, ...rel);
}

/** User-level config directory. SUPER_T_HOME overrides it (tests rely on this). */
export function homeDir(): string {
  return process.env.SUPER_T_HOME ?? nodePath.join(os.homedir(), STATE_DIR);
}

// The state directory holds two kinds of thing, and a user should not have to
// know which is which:
//   • SHARED standards — rules, context, skills, team.json, config.json.
//     These belong in the repo so the whole team gets them on `git pull`.
//   • LOCAL run state — backups (copies of every file an agent touched),
//     reports, flow output, caches, learned choices. Personal and noisy.
//
// So Super Terminal ships the distinction as a .gitignore inside its own
// directory. Nobody has to remember, and `git add -A` stops committing an
// agent's backup of your source tree.
const STATE_GITIGNORE = [
  "# Written by Super Terminal. Local run state — not for the repo.",
  "backup/",
  "reports/",
  "flow/",
  "wt/",
  "index.json",
  "intent.json",
  "session.json",
  "",
  "# Shared standards ARE committed: rules.md, context.md, product.md,",
  "# skills/, team.json, config.json — they are not listed above.",
  "",
].join("\n");

/**
 * Create the state directory, and make sure its .gitignore exists.
 * Use this instead of mkdir wherever state is first written.
 */
export async function ensureStateDir(root: string): Promise<string> {
  const dir = stateDir(root);
  await fs.mkdir(dir, { recursive: true });
  const ignore = nodePath.join(dir, ".gitignore");
  try {
    await fs.access(ignore);
  } catch {
    await fs.writeFile(ignore, STATE_GITIGNORE).catch(() => {});
  }
  return dir;
}
