import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findProjects, homeRelative } from "../src/commands/search";

let workspace: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glint-search-"));
  // A project with package.json, a project with .git, and a plain folder
  await fs.mkdir(path.join(workspace, "shop-app"), { recursive: true });
  await fs.writeFile(path.join(workspace, "shop-app", "package.json"), "{}");
  await fs.mkdir(path.join(workspace, "blog-site", ".git"), { recursive: true });
  await fs.mkdir(path.join(workspace, "just-notes"), { recursive: true });
  await fs.writeFile(path.join(workspace, "just-notes", "readme.txt"), "hi");

  // findProjects scans process.cwd() among its roots
  process.chdir(workspace);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("findProjects", () => {
  it("finds folders with package.json or .git", async () => {
    const names = (await findProjects(undefined, [workspace])).map((p) => path.basename(p));
    expect(names).toContain("shop-app");
    expect(names).toContain("blog-site");
  });

  it("skips folders that aren't projects", async () => {
    const names = (await findProjects(undefined, [workspace])).map((p) => path.basename(p));
    expect(names).not.toContain("just-notes");
  });

  it("filters by query", async () => {
    const names = (await findProjects("shop", [workspace])).map((p) => path.basename(p));
    expect(names).toContain("shop-app");
    expect(names).not.toContain("blog-site");
  });

  it("returns absolute paths", async () => {
    for (const p of await findProjects(undefined, [workspace])) expect(path.isAbsolute(p)).toBe(true);
  });
});

describe("homeRelative", () => {
  it("abbreviates the home directory to ~", () => {
    expect(homeRelative(os.homedir())).toBe("~");
    expect(homeRelative(path.join(os.homedir(), "Desktop", "x"))).toBe(path.join("~", "Desktop", "x"));
  });

  it("leaves paths outside home unchanged", () => {
    expect(homeRelative("/tmp/foo")).toBe("/tmp/foo");
  });
});
