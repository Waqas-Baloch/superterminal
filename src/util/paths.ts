import { promises as fs } from "node:fs";
import nodePath from "node:path";
import os from "node:os";

// Where Super Terminal keeps its state, and how it finds state written under
// the old names.
//
// Renaming a tool's directories is where people quietly lose their saved
// connection, their learned choices, and — worst — the backups that `revert`
// depends on. So the new name is what we WRITE, and the old names stay
// readable indefinitely. The cost is a few extra stat calls; the alternative
// is a user discovering the loss at the moment they need to undo something.

export const STATE_DIR = ".super-t";
/** Older names, newest first. `.glint` was the previous brand, `.squash` the one before. */
export const LEGACY_STATE_DIRS = [".glint", ".squash"];
export const ALL_STATE_DIRS = [STATE_DIR, ...LEGACY_STATE_DIRS];

/** Glob patterns that keep every state directory out of the repo index. */
export const STATE_IGNORE_GLOBS = ALL_STATE_DIRS.map((d) => `**/${d}/**`);

/** The directory to write project state into. */
export function stateDir(root: string): string {
  return nodePath.join(root, STATE_DIR);
}

/**
 * Find a project state file, preferring the current directory and falling back
 * to older ones. Returns an absolute path, or null when it exists nowhere.
 */
export async function findStateFile(root: string, rel: string): Promise<string | null> {
  for (const dir of ALL_STATE_DIRS) {
    const p = nodePath.join(root, dir, rel);
    if (await exists(p)) return p;
  }
  return null;
}

/** Every existing state directory in a project, current first. */
export async function existingStateDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ALL_STATE_DIRS) {
    const p = nodePath.join(root, dir);
    if (await exists(p)) found.push(p);
  }
  return found;
}

/**
 * User-level config directory. SUPER_T_HOME is the current override; GLINT_HOME
 * is still honoured so existing setups and scripts keep working.
 */
export function homeDir(): string {
  return process.env.SUPER_T_HOME ?? process.env.GLINT_HOME ?? nodePath.join(os.homedir(), STATE_DIR);
}

/** Home-level state files, current location first, then the older ones. */
export function homeCandidates(rel: string): string[] {
  const override = process.env.SUPER_T_HOME ?? process.env.GLINT_HOME;
  if (override) return [nodePath.join(override, rel)];
  return ALL_STATE_DIRS.map((d) => nodePath.join(os.homedir(), d, rel));
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
