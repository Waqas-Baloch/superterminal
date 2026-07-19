import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadContext, renderContextSection } from "../src/core/rules";
import {
  extractFileMentions,
  resolveMentions,
  readMentioned,
  renderMentionedSection,
  repoFileNames,
  forgetFileNames,
} from "../src/core/mentions";
import { generateManifest } from "../src/core/manifest";
import type { Selection } from "../src/core/selector";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-mentions-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
});
afterEach(async () => {
  forgetFileNames(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

const selection = (): Selection => ({
  task: "",
  primary: [],
  supporting: [],
  optional: [],
  totalTokens: 0,
  budget: 8000,
  taskType: "ui",
  taskConfidence: 1,
  anchors: [],
});

describe("project context — followed regardless of which agent runs", () => {
  it("finds context.md at the repo root", async () => {
    await fs.writeFile(path.join(dir, "context.md"), "Suncream is a skincare brand for teens.");
    const ctx = await loadContext(dir);
    expect(ctx.sources[0]).toBe("context.md");
    const rendered = renderContextSection(ctx);
    expect(rendered).toContain("skincare brand for teens");
    // Case-insensitive filesystems (macOS, Windows) resolve context.md and
    // CONTEXT.md to the same file — it must not be injected twice.
    expect(rendered.match(/skincare brand for teens/g)).toHaveLength(1);
  });

  it("is empty when the project has none", async () => {
    expect(await loadContext(dir)).toEqual({ text: "", sources: [] });
  });

  it("reaches every agent by riding in the manifest", async () => {
    await fs.writeFile(path.join(dir, "CONTEXT.md"), "Ship weekly. Users are on mobile.");
    const manifest = await generateManifest({ root: dir, task: "add a banner", selection: selection() });
    expect(manifest).toContain("## Project context");
    expect(manifest).toContain("Users are on mobile");
  });
});

describe("mentioned files — a context file under any other name", () => {
  it("picks filename-looking tokens out of a prompt", () => {
    const found = extractFileMentions("Review the landing page using landing-page.md for broken code");
    expect(found).toContain("landing-page.md");
  });

  it("ignores tokens that aren't filenames", () => {
    expect(extractFileMentions("make the hero section bigger")).toEqual([]);
  });

  it("resolves a mention only when the file exists", async () => {
    await fs.writeFile(path.join(dir, "brief.md"), "Tone: warm, plain-spoken.");
    expect(await resolveMentions(dir, "follow brief.md")).toEqual(["brief.md"]);
    expect(await resolveMentions(dir, "follow missing.md")).toEqual([]);
  });

  it("finds a mentioned file nested anywhere in the repo", async () => {
    await fs.mkdir(path.join(dir, "docs", "specs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "specs", "landing-page.md"), "Hero, then pricing.");
    expect(await resolveMentions(dir, "use landing-page.md")).toEqual(["docs/specs/landing-page.md"]);
  });

  it("injects the named file's content into the manifest", async () => {
    await fs.writeFile(path.join(dir, "checklist.md"), "1. No inline styles.");
    const manifest = await generateManifest({
      root: dir,
      task: "audit the page against checklist.md",
      selection: selection(),
    });
    expect(manifest).toContain("## Referenced files");
    expect(manifest).toContain("No inline styles");
  });

  it("renders nothing when nothing was named", () => {
    expect(renderMentionedSection([])).toBe("");
  });

  it("skips files that are empty", async () => {
    await fs.writeFile(path.join(dir, "blank.md"), "   ");
    expect(await readMentioned(dir, ["blank.md"])).toEqual([]);
  });
});

describe("repoFileNames — what the input highlights against", () => {
  it("indexes files by both full path and basename", async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "hero.tsx"), "export const Hero = () => null;");
    const names = await repoFileNames(dir, true);
    expect(names.has("src/hero.tsx")).toBe(true);
    expect(names.has("hero.tsx")).toBe(true);
    expect(names.has("nope.tsx")).toBe(false);
  });

  it("re-scans after the cache is dropped, so a new project isn't stale", async () => {
    await repoFileNames(dir, true);
    await fs.writeFile(path.join(dir, "late.md"), "added after the first scan");
    expect((await repoFileNames(dir)).has("late.md")).toBe(false); // served from cache
    forgetFileNames(dir);
    expect((await repoFileNames(dir)).has("late.md")).toBe(true);
  });
});
