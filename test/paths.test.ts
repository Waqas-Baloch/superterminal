import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { STATE_DIR, stateDir, statePath, homeDir, STATE_IGNORE_GLOBS } from "../src/util/paths";
import { loadRules, loadContext } from "../src/core/rules";
import { loadIntents, rememberChoice } from "../src/core/memory";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-paths-"));
  delete process.env.SUPER_T_HOME;
});
afterEach(async () => {
  delete process.env.SUPER_T_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};

describe("state lives in one place", () => {
  it("uses .super-t for project state", () => {
    expect(STATE_DIR).toBe(".super-t");
    expect(stateDir(dir)).toBe(path.join(dir, STATE_DIR));
    expect(statePath(dir, "backup", "run-1")).toBe(path.join(dir, STATE_DIR, "backup", "run-1"));
  });

  it("keeps the state directory out of the repo index", () => {
    expect(STATE_IGNORE_GLOBS).toEqual([`**/${STATE_DIR}/**`]);
  });

  it("puts user-level config under the home directory", () => {
    expect(homeDir()).toBe(path.join(os.homedir(), STATE_DIR));
  });

  it("lets SUPER_T_HOME override the home directory", () => {
    process.env.SUPER_T_HOME = "/tmp/elsewhere";
    expect(homeDir()).toBe("/tmp/elsewhere");
  });
});

describe("project files are read from the state directory", () => {
  it("reads rules", async () => {
    await write(`${STATE_DIR}/rules.md`, "Never edit dist/.");
    expect((await loadRules(dir)).text).toContain("Never edit dist/");
  });

  it("reads context", async () => {
    await write(`${STATE_DIR}/context.md`, "This is a skincare brand.");
    expect((await loadContext(dir)).text).toContain("skincare brand");
  });

  it("reads and writes learned choices", async () => {
    await rememberChoice(dir, { phrase: "buy", change: ["hero"], keep: ["footer"] });
    const intents = await loadIntents(dir);
    expect(intents).toHaveLength(1);
    expect(intents[0].phrase).toBe("buy");
    // Written where the rest of the state lives, not at the repo root.
    const onDisk = JSON.parse(await fs.readFile(statePath(dir, "intent.json"), "utf8"));
    expect(onDisk.choices[0].phrase).toBe("buy");
  });

  it("ignores a stale directory from the old name entirely", async () => {
    // Pre-rename builds had no real users, so nothing is read from .glint.
    await write(".glint/rules.md", "Stale rule that must not apply.");
    expect((await loadRules(dir)).text).not.toContain("Stale rule");
  });
});
