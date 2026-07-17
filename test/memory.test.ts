import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadIntents, recall, rememberChoice, forgetAll } from "../src/core/memory";
import { assessTask } from "../src/core/clarify";
import type { Selection } from "../src/core/selector";

const PAGE = [
  "<!doctype html><html><body>",
  '  <nav><button class="cta">Try Now</button></nav>',
  '  <footer id="support"><button class="cta">Try Now</button></footer>',
  "</body></html>",
].join("\n");

function sel(): Selection {
  return {
    task: "",
    primary: [{ path: "index.html", score: 1, tokens: 10, reasons: ["m"] }],
    supporting: [],
    optional: [],
    totalTokens: 10,
    budget: 30_000,
    taskType: "ui",
    taskConfidence: 0.9,
    anchors: [{ path: "index.html", score: 0.9 }],
  };
}

describe("repo memory store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-mem-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists, recalls, replaces, and forgets a choice", async () => {
    await rememberChoice(dir, { phrase: "Try Now", change: ["nav"], keep: ["footer#support"] });
    expect(recall(await loadIntents(dir), "try now")?.change).toEqual(["nav"]); // case-insensitive

    await rememberChoice(dir, { phrase: "Try Now", change: ["footer#support"], keep: ["nav"] }); // overwrite
    const intents = await loadIntents(dir);
    expect(intents).toHaveLength(1);
    expect(recall(intents, "Try Now")?.change).toEqual(["footer#support"]);

    expect(await forgetAll(dir)).toBe(1);
    expect(await loadIntents(dir)).toEqual([]);
  });
});

describe("memory recall inside assessTask — the second time, it doesn't ask", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-mem2-"));
    await fs.writeFile(path.join(dir, "index.html"), PAGE);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("asks the first time (no memory)", async () => {
    const a = await assessTask("remove the Try Now button", sel(), dir);
    expect(a.band).toBe("red"); // destructive duplicate across nav/footer
    expect(a.questions.some((q) => q.key === "target_location")).toBe(true);
    expect(a.recallNote).toBeNull();
  });

  it("auto-applies the remembered choice the second time — no question", async () => {
    await rememberChoice(dir, { phrase: "Try Now", change: ["nav"], keep: ["footer#support"] });
    const a = await assessTask("remove the Try Now button", sel(), dir);

    expect(a.questions).toEqual([]); // nothing asked
    expect(a.recallNote).toContain("Remembered choice");
    expect(a.autoScope?.change.map((i) => i.landmark)).toEqual(["nav"]);
    expect(a.autoScope?.keep.map((i) => i.landmark)).toEqual(["footer#support"]);
    expect(a.autoRefinements[0]).toContain("Change ONLY"); // the pinning constraint is compiled in
    expect(a.autoRefinements[0]).toContain("<nav>");
  });

  it("re-asks if the remembered occurrence no longer exists", async () => {
    await rememberChoice(dir, { phrase: "Try Now", change: ["aside"], keep: [] }); // aside isn't on the page
    const a = await assessTask("remove the Try Now button", sel(), dir);
    expect(a.recallNote).toBeNull();
    expect(a.questions.some((q) => q.key === "target_location")).toBe(true);
  });
});
