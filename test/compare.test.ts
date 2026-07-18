import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexRepo } from "../src/core/indexer";
import { loadConfig } from "../src/util/config";
import { snapshot, diffAgainst, restoreTo } from "../src/commands/compare";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-compare-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  await fs.writeFile(path.join(dir, "app.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(dir, "util.ts"), "export const u = 2;\n");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("compare — isolation between agents (revert-between must be exact)", () => {
  it("captures modified + created files, then restores to a pristine slate", async () => {
    const config = await loadConfig(dir);
    const before = await snapshot(dir, await indexRepo(dir, config));

    // Simulate an agent: modify one file, create another.
    await fs.writeFile(path.join(dir, "app.ts"), "export const a = 999;\n");
    await fs.writeFile(path.join(dir, "new.ts"), "export const n = 3;\n");

    const changes = await diffAgainst(dir, config, before);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath["app.ts"]).toMatchObject({ created: false, after: "export const a = 999;\n" });
    expect(byPath["new.ts"]).toMatchObject({ created: true });
    expect(byPath["util.ts"]).toBeUndefined(); // untouched

    // Restore — the next agent must see the original repo exactly.
    await restoreTo(dir, before, changes);
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await fs.access(path.join(dir, "new.ts")).then(() => true).catch(() => false)).toBe(false); // created file removed
    expect(await fs.readFile(path.join(dir, "util.ts"), "utf8")).toBe("export const u = 2;\n");
  });

  it("reports no changes when the agent did nothing", async () => {
    const config = await loadConfig(dir);
    const before = await snapshot(dir, await indexRepo(dir, config));
    expect(await diffAgainst(dir, config, before)).toEqual([]);
  });
});
