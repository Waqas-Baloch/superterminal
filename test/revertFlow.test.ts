import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { revertCommand } from "../src/commands/revert";
import { STATE_DIR } from "../src/util/paths";

// A flow writes ONE backup covering every step, so a four-step flow that goes
// wrong at step three is undone with a single command. Before this, a flow
// wrote no backup at all — the command most likely to need undoing was the one
// that couldn't be undone.

let dir: string;
let cwd: string;
let logs: string[];

beforeEach(async () => {
  cwd = process.cwd();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-revert-"));
  process.chdir(dir);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  await fs.rm(dir, { recursive: true, force: true });
});

/** Build a backup as a run (or flow) would have written it. */
async function backup(
  runId: string,
  opts: { originals?: Record<string, string>; created?: string[]; meta?: object },
): Promise<void> {
  const runDir = path.join(dir, STATE_DIR, "backup", runId);
  for (const [rel, body] of Object.entries(opts.originals ?? {})) {
    const dest = path.join(runDir, "files", rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body);
  }
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "created.json"), JSON.stringify(opts.created ?? []));
  if (opts.meta) await fs.writeFile(path.join(runDir, "meta.json"), JSON.stringify(opts.meta));
}

const output = (): string => logs.join("\n");

describe("revert understands flows", () => {
  it("restores every file a multi-step flow touched, in one command", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "changed by step 1");
    await fs.writeFile(path.join(dir, "b.txt"), "changed by step 2");
    await backup("2026-07-19T10-00-00-000Z", {
      originals: { "a.txt": "original a", "b.txt": "original b" },
      meta: { kind: "flow", steps: 2, completed: 2 },
    });

    await revertCommand();

    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("original a");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("original b");
    expect(output()).toContain("2-step flow");
  });

  it("says how far a flow got when it stopped partway", async () => {
    // The case that matters: step 3 of 4 went wrong.
    await fs.writeFile(path.join(dir, "a.txt"), "half-done");
    await backup("2026-07-19T11-00-00-000Z", {
      originals: { "a.txt": "original a" },
      meta: { kind: "flow", steps: 4, completed: 2 },
    });

    await revertCommand();

    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("original a");
    expect(output()).toContain("stopped after 2 of 4");
  });

  it("deletes files a flow created", async () => {
    await fs.writeFile(path.join(dir, "new.txt"), "made by the flow");
    await backup("2026-07-19T12-00-00-000Z", {
      created: ["new.txt"],
      meta: { kind: "flow", steps: 2, completed: 2 },
    });

    await revertCommand();

    await expect(fs.access(path.join(dir, "new.txt"))).rejects.toThrow();
  });

  it("still describes a plain run as a run", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "changed");
    await backup("2026-07-19T13-00-00-000Z", { originals: { "a.txt": "original a" } });

    await revertCommand();

    expect(output()).toContain("Reverted run");
    expect(output()).not.toContain("flow");
  });

  it("reverts the most recent run when several exist", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "latest change");
    await backup("2026-07-19T09-00-00-000Z", { originals: { "a.txt": "older" } });
    await backup("2026-07-19T14-00-00-000Z", {
      originals: { "a.txt": "newer" },
      meta: { kind: "flow", steps: 3, completed: 3 },
    });

    await revertCommand();

    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("newer");
    expect(output()).toContain("3-step flow");
  });

  it("says so plainly when there's nothing to revert", async () => {
    await revertCommand();
    expect(output()).toContain("Nothing to revert");
  });
});
