import { promises as fs } from "node:fs";
import { spin } from "../report/spinner";
import os from "node:os";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { log } from "../util/logger";
import { runCommand } from "./run";

const HOME_DIRS = ["Desktop", "Documents", "Projects", "projects", "code", "Code", "dev", "src", "repos", "workspace", "work", "git", "sites"];
const SKIP_DIRS = new Set(["node_modules", ".git", "Library", ".Trash", ".cache", ".npm", "dist", "build", ".next"]);
const MARKERS = ["package.json", ".git"];
const SCAN_DEPTH = 2;

export function homeRelative(dir: string): string {
  const home = os.homedir();
  return dir === home ? "~" : dir.startsWith(home + nodePath.sep) ? "~" + dir.slice(home.length) : dir;
}

function candidateRoots(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();
  return [...new Set([cwd, nodePath.dirname(cwd), home, ...HOME_DIRS.map((d) => nodePath.join(home, d))])];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isProject(dir: string): Promise<boolean> {
  for (const marker of MARKERS) {
    try {
      await fs.access(nodePath.join(dir, marker));
      return true;
    } catch {
      // marker absent — keep checking
    }
  }
  return false;
}

async function scan(dir: string, depth: number, found: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable (permissions, etc.)
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    const child = nodePath.join(dir, e.name);
    if (await isProject(child)) {
      found.add(child); // a project's own subfolders aren't separate projects — don't recurse in
    } else if (depth > 1) {
      await scan(child, depth - 1, found);
    }
  }
}

/**
 * Find folders that look like projects (contain package.json or .git) up to
 * SCAN_DEPTH levels under common roots. `roots` is overridable for testing.
 */
export async function findProjects(query?: string, roots?: string[]): Promise<string[]> {
  const bases: string[] = [];
  for (const r of roots ?? candidateRoots()) if (await isDir(r)) bases.push(r);

  const found = new Set<string>();
  for (const base of bases) await scan(base, SCAN_DEPTH, found);

  let list = [...found];
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((p) => nodePath.basename(p).toLowerCase().includes(q) || p.toLowerCase().includes(q));
  }
  return list.sort((a, b) => nodePath.basename(a).localeCompare(nodePath.basename(b)));
}

async function expandPath(input: string): Promise<string | null> {
  let p = input.trim();
  if (!p) return null;
  if (p === "~" || p.startsWith("~/")) p = nodePath.join(os.homedir(), p.slice(1));
  p = nodePath.resolve(p);
  return (await isDir(p)) ? p : null;
}

/** Interactive: search for a project and return its absolute path, or null if cancelled. */
export async function pickProject(query?: string): Promise<string | null> {
  const spinner = spin("Scanning for projects…").start();
  const projects = await findProjects(query);
  spinner.stop();

  if (projects.length === 0) {
    log.info(query ? `No projects matched "${query}".` : "No projects found in the usual places.");
    return manualEntry();
  }

  const { choice } = await prompts({
    type: "autocomplete",
    name: "choice",
    message: `Select a project${query ? ` matching "${query}"` : ""}`,
    choices: [
      ...projects.map((p) => ({ title: homeRelative(p), value: p })),
      { title: pc.dim("Enter a path manually…"), value: "__manual__" },
    ],
  });

  if (choice === undefined) return null;
  if (choice === "__manual__") return manualEntry();
  return choice;
}

async function manualEntry(): Promise<string | null> {
  const { path } = await prompts({ type: "text", name: "path", message: "Project folder path:" });
  if (path === undefined) return null;
  const resolved = await expandPath(String(path));
  if (!resolved) {
    log.error("That folder doesn't exist.");
    return null;
  }
  return resolved;
}

/**
 * Standalone `glint search [query]`: pick a project, change into it, and start
 * a session there. A CLI can't change the parent shell's directory, so we
 * chdir the Glint process itself and run the session in that root.
 */
export async function searchCommand(query?: string): Promise<void> {
  const root = await pickProject(query);
  if (!root) {
    log.info("Cancelled — no project selected.");
    return;
  }
  process.chdir(root);
  log.success(`Working in ${pc.bold(homeRelative(root))}`);
  log.info("");
  await runCommand(undefined, {});
}
