import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  AGENT_CLIS,
  isGitRepo,
  hasHeadCommit,
  gitInit,
  gitBaselineCommit,
  gitDirtyFiles,
  gitBefore,
} from "../src/claude/agentCli";

let dir: string;

describe("agent CLI registry", () => {
  it("composes headless args for each agent", () => {
    expect(AGENT_CLIS["claude-code"].runArgs("do x")).toEqual(["-p", "do x", "--permission-mode", "acceptEdits"]);
    expect(AGENT_CLIS.cursor.runArgs("do x")).toEqual(["-p", "do x", "--force"]);
    expect(AGENT_CLIS.codex.runArgs("do x")).toEqual(["exec", "--sandbox", "workspace-write", "do x"]);
  });

  it("continuation keeps the repair prompt intact", () => {
    for (const agent of Object.values(AGENT_CLIS)) {
      const args = agent.continueArgs("fix the tsc errors");
      expect(args.join(" ")).toContain("fix the tsc errors");
    }
  });
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-git-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-qm", "init"], { cwd: dir });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("git helpers", () => {
  it("detects a git repo (and a non-repo)", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    expect(await isGitRepo(os.tmpdir())).toBe(false);
  });

  it("reports modified and untracked files after a change", async () => {
    expect((await gitDirtyFiles(dir)).size).toBe(0);
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(dir, "new.ts"), "export const fresh = 1;\n");
    const dirty = await gitDirtyFiles(dir);
    expect(dirty.has("a.ts")).toBe(true);
    expect(dirty.has("new.ts")).toBe(true);
  });

  it("returns HEAD content for tracked files and null for new files", async () => {
    expect(await gitBefore(dir, "a.ts")).toBe("export const a = 1;\n");
    expect(await gitBefore(dir, "new.ts")).toBeNull();
  });

  it("bootstraps a fresh repo with a baseline commit", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "glint-fresh-"));
    await fs.writeFile(path.join(fresh, "style.css"), "body { margin: 0; }\n");

    expect(await isGitRepo(fresh)).toBe(false);
    await gitInit(fresh);
    expect(await isGitRepo(fresh)).toBe(true);
    expect(await hasHeadCommit(fresh)).toBe(false);

    await gitBaselineCommit(fresh);
    expect(await hasHeadCommit(fresh)).toBe(true);
    expect(await gitBefore(fresh, "style.css")).toBe("body { margin: 0; }\n");

    await fs.rm(fresh, { recursive: true, force: true });
  });
});
