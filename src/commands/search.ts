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
    const { next } = await prompts({
      type: "select",
      name: "next",
      message: "What now?",
      choices: [
        { title: "Create a new project", description: "make a folder and start there", value: "__new__" },
        { title: "Enter a path manually", value: "__manual__" },
      ],
    });
    if (next === "__new__") return createProject(query);
    if (next === "__manual__") return manualEntry();
    return null;
  }

  const { choice } = await prompts({
    type: "autocomplete",
    name: "choice",
    message: `Select a project${query ? ` matching "${query}"` : ""}`,
    choices: [
      // First, because "the project I want doesn't exist yet" is the case the
      // old picker had no answer for — you had to leave, mkdir, and come back.
      { title: "＋ New project…", description: "create a folder and start there", value: "__new__" },
      ...projects.map((p) => ({ title: homeRelative(p), value: p })),
      { title: pc.dim("Enter a path manually…"), value: "__manual__" },
    ],
  });

  if (choice === undefined) return null;
  if (choice === "__new__") return createProject(query);
  if (choice === "__manual__") return manualEntry();
  return choice;
}

/** Folders worth offering as a home for a new project, most likely first. */
async function parentChoices(): Promise<string[]> {
  const home = os.homedir();
  const cwd = process.cwd();
  // The dirs this already scans for projects are, by definition, where this
  // person keeps projects — so they are also where the next one belongs.
  const candidates = [...HOME_DIRS.map((d) => nodePath.join(home, d)), home, nodePath.dirname(cwd)];
  const live: string[] = [];
  for (const c of [...new Set(candidates)]) {
    if (await isDir(c)) live.push(c);
  }
  return live;
}

/**
 * Create a project folder and return it, or null if cancelled.
 *
 * Offered from inside the picker because "the project I want doesn't exist yet"
 * was the one answer it had no path for: you had to leave the session, mkdir,
 * and come back. The location is asked for rather than assumed — putting a new
 * folder somewhere the person didn't choose is the kind of thing you only notice
 * a week later.
 */
async function createProject(suggested?: string): Promise<string | null> {
  const parents = await parentChoices();

  const { parent } = await prompts({
    type: "select",
    name: "parent",
    message: "Where should it go?",
    choices: [...parents.map((p) => ({ title: homeRelative(p), value: p })), { title: pc.dim("Somewhere else…"), value: "__other__" }],
  });
  if (parent === undefined) return null;

  let base = parent as string;
  if (base === "__other__") {
    const { where } = await prompts({ type: "text", name: "where", message: "Parent folder path:" });
    if (where === undefined) return null;
    const resolved = await expandPath(String(where));
    if (!resolved) {
      log.error("That folder doesn't exist. Create it first, then try again.");
      return null;
    }
    base = resolved;
  }

  const { name } = await prompts({
    type: "text",
    name: "name",
    message: "Project name",
    initial: suggested ?? "",
    validate: (v: string) => {
      const t = String(v ?? "").trim();
      if (!t) return "Needs a name";
      // Anything that could climb out of the parent, or that the filesystem will
      // mangle. A project called "../x" is not a project.
      if (/[/\\]|^\.\.?$/.test(t)) return "No slashes — this is a folder name, not a path";
      return true;
    },
  });
  if (!name) return null;

  const dir = nodePath.join(base, String(name).trim());
  if (await isDir(dir)) {
    log.error(`${homeRelative(dir)} already exists.`);
    log.dim("  Pick it from the list instead, or choose another name.");
    return null;
  }

  try {
    await fs.mkdir(dir, { recursive: false });
  } catch (err) {
    log.error(`Could not create it: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  log.success(`Created ${homeRelative(dir)}`);
  log.dim("  Empty folder — no git repo and no files. `super-t init` drafts a rules file when you want one.");
  return dir;
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
 * Standalone `super-t search [query]`: pick a project, change into it, and start
 * a session there. A CLI can't change the parent shell's directory, so we
 * chdir the Super Terminal process itself and run the session in that root.
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
