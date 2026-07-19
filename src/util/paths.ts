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
