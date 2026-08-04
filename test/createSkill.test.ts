import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSkills, matchSkills } from "../src/core/skills";
import { STATE_DIR } from "../src/util/paths";

// The scaffolder's whole job is producing frontmatter that actually works. A
// skill whose `when:` line is missing or malformed never fires and says nothing
// about it — the task just runs without it. So assert on behaviour (does it
// match a task?) rather than on the file's text.
let dir: string;

// Byte-for-byte what /create writes for a skill.
const GENERATED = `---
name: changelog-writer
description: Write release notes from the diff, grouped by user impact
when: changelog, release notes, version bump
---

Write the instructions here, addressed to whichever agent picks this up.
`;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-create-"));
  const p = path.join(dir, STATE_DIR, "skills", "changelog-writer");
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, "SKILL.md"), GENERATED);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a skill created by /create", () => {
  it("loads back with its name, description and triggers intact", async () => {
    const skills = await loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("changelog-writer");
    expect(skills[0].description).toContain("release notes");
    expect(skills[0].triggers).toEqual(["changelog", "release notes", "version bump"]);
  });

  it("actually fires on a task that mentions a trigger", async () => {
    const skills = await loadSkills(dir);
    expect(matchSkills("write a changelog for 2.3.0", skills).map((s) => s.name)).toEqual(["changelog-writer"]);
    expect(matchSkills("bump the version and write release notes", skills)).toHaveLength(1);
  });

  it("stays out of the way of unrelated tasks", async () => {
    const skills = await loadSkills(dir);
    expect(matchSkills("add a login form to the checkout page", skills)).toHaveLength(0);
  });
});

// A skill kept in .claude/skills/ for Claude Code and mirrored into
// <state>/skills/ by `skills sync` used to load twice. Only three skills reach
// the manifest, so a duplicate can silently crowd out one that would have
// applied — the task then runs without it and looks fine.
describe("the same skill in two places loads once", () => {
  let dupDir: string;

  beforeAll(async () => {
    dupDir = await fs.mkdtemp(path.join(os.tmpdir(), "st-dup-"));
    const same = `---\nname: shared\ndescription: present in both locations\nwhen: shared\n---\n\nBody.\n`;
    for (const p of [path.join(dupDir, STATE_DIR, "skills", "shared"), path.join(dupDir, ".claude", "skills", "shared")]) {
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(path.join(p, "SKILL.md"), same);
    }
  });

  afterAll(async () => {
    await fs.rm(dupDir, { recursive: true, force: true });
  });

  it("loads one copy, not two", async () => {
    const skills = await loadSkills(dupDir);
    expect(skills.filter((s) => s.name === "shared")).toHaveLength(1);
  });
});
