import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSkills, matchSkills, renderSkillsSection } from "../src/core/skills";
import { generateManifest } from "../src/core/manifest";
import type { Selection } from "../src/core/selector";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-skills-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeSkill(rel: string, content: string): Promise<void> {
  const p = path.join(dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

describe("loadSkills — read Glint's and Claude Code's", () => {
  it("reads .glint/skills and .claude/skills, with frontmatter", async () => {
    await writeSkill(
      ".glint/skills/api-endpoint/SKILL.md",
      `---\nname: API endpoint\ndescription: how we add a REST endpoint\nwhen: endpoint, route\n---\n1. Add the handler.\n2. Register the route.`,
    );
    await writeSkill(".claude/skills/testing/SKILL.md", `---\nname: Testing\ndescription: how we write tests\n---\nUse vitest.`);

    const skills = await loadSkills(dir);
    expect(skills.map((s) => s.name).sort()).toEqual(["API endpoint", "Testing"]);
    const api = skills.find((s) => s.name === "API endpoint")!;
    expect(api.triggers).toEqual(["endpoint", "route"]);
    expect(api.body).toContain("Register the route");
  });

  it("falls back to the folder name when there's no frontmatter", async () => {
    await writeSkill(".glint/skills/deploys/SKILL.md", "Always tag a release first.");
    const [s] = await loadSkills(dir);
    expect(s.name).toBe("deploys");
    expect(s.body).toBe("Always tag a release first.");
  });
});

describe("matchSkills — fires only when relevant", () => {
  const skills = [
    { name: "API endpoint", description: "how we add a REST endpoint", triggers: ["endpoint"], body: "x", source: "a" },
    { name: "Testing", description: "how we write unit tests here", triggers: [], body: "y", source: "b" },
  ];

  it("matches an explicit trigger", () => {
    expect(matchSkills("add a users endpoint", skills).map((s) => s.name)).toEqual(["API endpoint"]);
  });

  it("matches on real word overlap when there's no trigger", () => {
    expect(matchSkills("write unit tests for the cart", skills).map((s) => s.name)).toEqual(["Testing"]);
  });

  it("stays quiet for unrelated tasks (no skill flooding)", () => {
    expect(matchSkills("make the header sticky", skills)).toEqual([]);
  });

  it("renders nothing when nothing matched", () => {
    expect(renderSkillsSection([])).toBe("");
  });
});

describe("skills reach the manifest — for whichever agent runs", () => {
  it("injects a matching skill and omits an unrelated one", async () => {
    await writeSkill(
      ".glint/skills/api-endpoint/SKILL.md",
      `---\nname: API endpoint\ndescription: how we add a REST endpoint\nwhen: endpoint\n---\nAlways validate the body with zod.`,
    );
    await writeSkill(".glint/skills/styling/SKILL.md", `---\nname: Styling\ndescription: how we do CSS\nwhen: css\n---\nUse tokens.`);
    await fs.writeFile(path.join(dir, "app.ts"), "export const x = 1;\n");

    const selection: Selection = {
      task: "add a users endpoint",
      primary: [{ path: "app.ts", score: 1, tokens: 10, reasons: ["m"] }],
      supporting: [],
      optional: [],
      totalTokens: 10,
      budget: 30_000,
      taskType: "ui",
      taskConfidence: 0.9,
      anchors: [],
    };
    const manifest = await generateManifest({ root: dir, task: "add a users endpoint", selection });

    expect(manifest).toContain("## Applicable skills");
    expect(manifest).toContain("Always validate the body with zod");
    expect(manifest).toContain("whichever agent you are");
    expect(manifest).not.toContain("Use tokens."); // the CSS skill wasn't relevant
  });
});
