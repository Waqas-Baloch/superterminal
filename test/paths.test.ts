import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { STATE_DIR, stateDir, findStateFile, existingStateDirs, ALL_STATE_DIRS } from "../src/util/paths";
import { loadRules, loadContext } from "../src/core/rules";
import { loadIntents, rememberChoice } from "../src/core/memory";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-paths-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};

// The rename must not cost anyone their saved state. Everything below is a
// user who set Super Terminal up under an older name.

describe("renaming must not orphan a user's existing state", () => {
  it("writes to the current directory", () => {
    expect(stateDir(dir)).toBe(path.join(dir, STATE_DIR));
    expect(STATE_DIR).toBe(".super-t");
  });

  it("still lists the old brand's directories as legacy", () => {
    expect(ALL_STATE_DIRS).toContain(".glint");
    expect(ALL_STATE_DIRS[0]).toBe(STATE_DIR); // current one wins ties
  });

  it("finds a file left in the old directory", async () => {
    await write(".glint/intent.json", "{}");
    expect(await findStateFile(dir, "intent.json")).toBe(path.join(dir, ".glint", "intent.json"));
  });

  it("prefers the current directory when both exist", async () => {
    await write(".glint/intent.json", "{}");
    await write(`${STATE_DIR}/intent.json`, "{}");
    expect(await findStateFile(dir, "intent.json")).toBe(path.join(dir, STATE_DIR, "intent.json"));
  });

  it("reports every state directory present, current first", async () => {
    await write(".glint/backup/run-1/created.json", "[]");
    await write(`${STATE_DIR}/backup/run-2/created.json`, "[]");
    const dirs = await existingStateDirs(dir);
    expect(dirs).toEqual([path.join(dir, STATE_DIR), path.join(dir, ".glint")]);
  });

  it("still reads rules written under the old name", async () => {
    await write(".glint/rules.md", "Never edit dist/.");
    expect((await loadRules(dir)).text).toContain("Never edit dist/");
  });

  it("still reads context written under the old name", async () => {
    await write(".glint/context.md", "This is a skincare brand.");
    expect((await loadContext(dir)).text).toContain("skincare brand");
  });

  it("still reads learned choices written under the old name", async () => {
    await write(
      ".glint/intent.json",
      JSON.stringify({
        version: 1,
        choices: [{ phrase: "try now", change: ["nav"], keep: ["footer"], updatedAt: "2026-01-01" }],
      }),
    );
    const intents = await loadIntents(dir);
    expect(intents).toHaveLength(1);
    expect(intents[0].phrase).toBe("try now");
  });

  it("writes new choices to the current directory, leaving the old file alone", async () => {
    await write(".glint/intent.json", JSON.stringify({ version: 1, choices: [] }));
    await rememberChoice(dir, { phrase: "buy", change: ["hero"], keep: [] });
    const written = JSON.parse(await fs.readFile(path.join(dir, STATE_DIR, "intent.json"), "utf8"));
    expect(written.choices[0].phrase).toBe("buy");
  });
});
