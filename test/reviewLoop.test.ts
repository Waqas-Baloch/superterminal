import { describe, it, expect } from "vitest";
import { reviewGaps } from "../src/commands/run";
import type { ReviewVerdict } from "../src/core/review";

// reviewGaps is the loop's brake. Returning null stops the retry; returning a
// prompt spends another turn of the user's own subscription quota. Both wrong
// answers are expensive: stopping early leaves work unfinished, and continuing
// on nothing actionable burns a turn to produce another vague answer.
const v = (over: Partial<ReviewVerdict>): ReviewVerdict => ({
  approved: false,
  notes: [],
  reviewer: "Codex",
  criteria: [],
  ...over,
});

describe("reviewGaps — when the loop keeps going", () => {
  it("stops when everything passed", () => {
    expect(reviewGaps(v({ approved: true, criteria: [{ index: 1, status: "met", note: "" }] }))).toBeNull();
  });

  it("stops when nothing reviewed it — there is nothing to act on", () => {
    expect(reviewGaps(null)).toBeNull();
  });

  it("stops on a vague failure with no specifics", () => {
    // "Issues were raised" is not a repair instruction. Retrying on it spends a
    // turn to get another vague answer.
    expect(reviewGaps(v({ approved: false, notes: [] }))).toBeNull();
  });

  it("continues on an unmet criterion, and carries the reason", () => {
    const g = reviewGaps(v({ criteria: [{ index: 2, status: "not_met", note: "no error branch for a failed payment" }] }));
    expect(g).not.toBeNull();
    expect(g!.prompt).toContain("no error branch for a failed payment");
    expect(g!.lines[0]).toContain("2.");
  });

  it("continues on concrete issues even when criteria all passed", () => {
    const g = reviewGaps(v({ approved: false, criteria: [{ index: 1, status: "met", note: "" }], notes: ["auth.ts: token logged in plaintext"] }));
    expect(g!.prompt).toContain("token logged in plaintext");
  });

  it("tells the agent not to redo accepted work", () => {
    // Without this the retry re-opens work the reviewer already passed, which is
    // how a fix turns into a second round of scope creep.
    const g = reviewGaps(v({ criteria: [{ index: 1, status: "not_met", note: "missing" }] }));
    expect(g!.prompt).toMatch(/do not revisit work that was already accepted/i);
  });

  it("does not retry forever on unknown verdicts", () => {
    // "unknown" means the reviewer could not judge it, not that it failed.
    expect(reviewGaps(v({ approved: true, criteria: [{ index: 1, status: "unknown", note: "could not tell" }] }))).toBeNull();
  });
});
