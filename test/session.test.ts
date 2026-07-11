import { describe, it, expect } from "vitest";
import { isFollowUp, seedsFrom, buildSessionNote, type SessionMemory } from "../src/core/session";

const memory: SessionMemory = {
  task: "add a buy button to the pricing section",
  touched: ["index.html", "styles.css"],
  summary: "Added a buy button inside #pricing and styled it.",
};

describe("isFollowUp", () => {
  it("detects referential language", () => {
    expect(isFollowUp("make it darker", memory)).toBe(true);
    expect(isFollowUp("actually undo the hover effect", memory)).toBe(true);
  });

  it("detects short tasks as follow-ups", () => {
    expect(isFollowUp("bigger font", memory)).toBe(true);
  });

  it("treats long, self-contained tasks as new work", () => {
    expect(isFollowUp("add a brand new contact page with a form and validation", memory)).toBe(false);
  });

  it("is never a follow-up without memory", () => {
    expect(isFollowUp("make it darker", undefined)).toBe(false);
  });
});

describe("seedsFrom", () => {
  it("seeds previous files strongly for follow-ups", () => {
    const seeds = seedsFrom("make it darker", memory);
    expect(seeds.map((s) => s.path)).toEqual(["index.html", "styles.css"]);
    expect(seeds[0].score).toBe(0.65);
    expect(seeds[0].reason).toContain("follow-up");
  });

  it("seeds weakly for unrelated new tasks", () => {
    const seeds = seedsFrom("add a brand new contact page with a form and validation", memory);
    expect(seeds[0].score).toBe(0.2);
  });

  it("returns nothing without memory", () => {
    expect(seedsFrom("make it darker", undefined)).toEqual([]);
  });
});

describe("buildSessionNote", () => {
  it("summarizes the previous task compactly", () => {
    const note = buildSessionNote(memory)!;
    expect(note).toContain("add a buy button");
    expect(note).toContain("index.html, styles.css");
    expect(note).toContain("Added a buy button");
  });

  it("is undefined without memory", () => {
    expect(buildSessionNote(undefined)).toBeUndefined();
  });
});
