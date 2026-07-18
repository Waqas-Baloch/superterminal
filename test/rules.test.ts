import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRules, renderRulesSection } from "../src/core/rules";
import { generateManifest } from "../src/core/manifest";
import type { Selection } from "../src/core/selector";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-rules-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadRules — read what teams already have", () => {
  it("returns nothing when there are no rule files", async () => {
    expect(await loadRules(dir)).toEqual({ text: "", sources: [] });
  });

  it("reads existing agent files (CLAUDE.md, .cursorrules) and Glint's own", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Never edit files under generated/.");
    await fs.writeFile(path.join(dir, ".cursorrules"), "Use tabs, not spaces.");
    await fs.mkdir(path.join(dir, ".glint"), { recursive: true });
    await fs.writeFile(path.join(dir, ".glint", "rules.md"), "Run npm test before finishing.");

    const rules = await loadRules(dir);
    expect(rules.sources).toEqual([".glint/rules.md", "CLAUDE.md", ".cursorrules"]);
    expect(rules.text).toContain("Never edit files under generated/.");
    expect(rules.text).toContain("Use tabs, not spaces.");
    expect(rules.text).toContain("Run npm test before finishing.");
  });

  it("reads nested .cursor/rules/*.md", async () => {
    await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cursor", "rules", "style.md"), "Prefer named exports.");
    const rules = await loadRules(dir);
    expect(rules.sources).toContain(".cursor/rules/style.md");
    expect(rules.text).toContain("Prefer named exports.");
  });

  it("renders an empty section when there are no rules", () => {
    expect(renderRulesSection({ text: "", sources: [] })).toBe("");
  });
});

describe("rules reach the manifest — the neutral layer in action", () => {
  it("a CLAUDE.md rule lands in the manifest that goes to ANY agent", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "RULE: never touch the /payments directory.");
    await fs.writeFile(path.join(dir, "app.ts"), "export const x = 1;\n");

    const selection: Selection = {
      task: "tweak x",
      primary: [{ path: "app.ts", score: 1, tokens: 10, reasons: ["m"] }],
      supporting: [],
      optional: [],
      totalTokens: 10,
      budget: 30_000,
      taskType: "refactor",
      taskConfidence: 0.9,
      anchors: [],
    };
    const manifest = await generateManifest({ root: dir, task: "tweak x", selection });

    expect(manifest).toContain("## Project rules");
    expect(manifest).toContain("never touch the /payments directory");
    expect(manifest).toContain("no matter which agent you are"); // the cross-agent framing
  });
});

describe("glint init — drafts a starter rules file", () => {
  it("detects the test script and generated dirs, and doesn't clobber an existing file", async () => {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });

    const { initCommand } = await import("../src/commands/init");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await initCommand();
      const written = await fs.readFile(path.join(dir, ".glint", "rules.md"), "utf8");
      expect(written).toContain("dist/"); // detected generated dir
      expect(written).toContain("npm test"); // detected test script
      expect(written).toContain("# Glint project rules");

      // Second run must not overwrite the user's edits.
      await fs.writeFile(path.join(dir, ".glint", "rules.md"), "MY EDITED RULES");
      await initCommand();
      expect(await fs.readFile(path.join(dir, ".glint", "rules.md"), "utf8")).toBe("MY EDITED RULES");
    } finally {
      process.chdir(cwd);
    }
  });
});
