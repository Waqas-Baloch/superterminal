import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { skillsCommand, upsertAgentsSection } from "../src/commands/skillsCmd";
import { STATE_DIR } from "../src/util/paths";

let dir: string;
let cwd: string;
beforeEach(async () => {
  cwd = process.cwd();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-skills-sync-"));
  process.chdir(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};

describe("skills sync — the neutral store becomes the source of truth", () => {
  it("materializes into .claude/skills and lists in AGENTS.md", async () => {
    await write(`${STATE_DIR}/skills/seo/SKILL.md`, "---\nname: SEO\n---\nAlways write meta descriptions.");
    await skillsCommand("sync");
    const claude = await fs.readFile(path.join(dir, ".claude", "skills", "seo", "SKILL.md"), "utf8");
    expect(claude).toContain("meta descriptions");
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("**seo**");
    expect(agents).toContain(`${STATE_DIR}/skills/seo/SKILL.md`);
  });

  it("re-sync replaces its own AGENTS.md section instead of appending twice", async () => {
    await write(`${STATE_DIR}/skills/seo/SKILL.md`, "x");
    await skillsCommand("sync");
    await skillsCommand("sync");
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents.match(/super-t:skills:start/g)).toHaveLength(1);
  });

  it("keeps hand-written AGENTS.md content around the managed section", async () => {
    await write("AGENTS.md", "# Our agents doc\nAlways use pnpm.\n");
    await write(`${STATE_DIR}/skills/x/SKILL.md`, "y");
    await skillsCommand("sync");
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Always use pnpm.");
    expect(agents).toContain("super-t:skills:start");
  });

  it("import pulls vendor skills into the neutral store without clobbering", async () => {
    await write(".claude/skills/testing/SKILL.md", "vendor version");
    await write(`${STATE_DIR}/skills/seo/SKILL.md`, "already neutral");
    await skillsCommand("import");
    const imported = await fs.readFile(path.join(dir, STATE_DIR, "skills", "testing", "SKILL.md"), "utf8");
    expect(imported).toBe("vendor version");
    // pre-existing neutral skill untouched
    expect(await fs.readFile(path.join(dir, STATE_DIR, "skills", "seo", "SKILL.md"), "utf8")).toBe("already neutral");
  });
});

describe("upsertAgentsSection", () => {
  it("creates a doc when none exists", () => {
    const out = upsertAgentsSection("", [{ name: "a", rel: "s/a.md", content: "" }]);
    expect(out).toContain("# Agent instructions");
    expect(out).toContain("**a**");
  });
});
