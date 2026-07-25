import { describe, it, expect } from "vitest";
import { resolveReviewer, reviewerSource, chooseReviewer, buildReviewPrompt, parseVerdict } from "../src/core/review";
import { AGENT_CLIS, isAgentInstalled } from "../src/claude/agentCli";

const config = (reviewer?: "claude-code" | "cursor" | "codex") =>
  ({ model: "m", mode: "standard", reviewer, budgetTokens: 1000, include: [], exclude: [] }) as never;

describe("resolveReviewer — config wins, rules line works, spelling is forgiven", () => {
  it("reads the config field", () => {
    expect(resolveReviewer(config("codex"), "")).toBe("codex");
  });

  it("reads a `review: codex` line from any rules file", () => {
    expect(resolveReviewer(config(), "Use tabs.\nreview: codex\nNever edit dist/.")).toBe("codex");
    expect(resolveReviewer(config(), "REVIEW: Claude Code")).toBe("claude-code");
  });

  it("returns null when nothing is configured — review is opt-in", () => {
    expect(resolveReviewer(config(), "just ordinary rules")).toBeNull();
  });
});

describe("buildReviewPrompt — the reviewer is told it is a reviewer", () => {
  const p = buildReviewPrompt("remove the buy button", ["index.html", "style.css"], "Never edit dist/.");

  it("forbids editing and demands the fixed verdict format", () => {
    expect(p).toContain("Do NOT modify any files");
    expect(p).toContain("VERDICT: APPROVE");
    expect(p).toContain("VERDICT: ISSUES");
  });

  it("carries the task, the changed files, and the rules", () => {
    expect(p).toContain("remove the buy button");
    expect(p).toContain("index.html");
    expect(p).toContain("Never edit dist/");
  });
});

describe("parseVerdict — unparseable output must never become a fake APPROVE", () => {
  it("reads a clean approve", () => {
    const v = parseVerdict("VERDICT: APPROVE\n- looks minimal and in scope", "Codex");
    expect(v.approved).toBe(true);
  });

  it("reads issues with findings", () => {
    const v = parseVerdict("VERDICT: ISSUES\n- style.css: removed a rule the task didn't mention\n- index.html: button id changed", "Codex");
    expect(v.approved).toBe(false);
    expect(v.notes).toHaveLength(2);
    expect(v.notes[0]).toContain("style.css");
  });

  it("treats verdict-less output with findings as issues, not approval", () => {
    const v = parseVerdict("I noticed some problems:\n- the diff also reformats app.ts", "Codex");
    expect(v.approved).toBe(false);
    expect(v.notes).toHaveLength(1);
  });

  it("case-insensitive on the verdict line", () => {
    expect(parseVerdict("verdict: approve", "X").approved).toBe(true);
  });
});

describe("resolveReviewer — most specific setting wins, global as the floor", () => {
  it("falls back to the machine default when a project says nothing", () => {
    expect(resolveReviewer(config(), "", "codex")).toBe("codex");
    expect(resolveReviewer(config(), "", null)).toBeNull();
  });

  it("a project's own setting beats the machine default", () => {
    expect(resolveReviewer(config("cursor"), "", "codex")).toBe("cursor");
  });

  it("a rules-file line beats the machine default", () => {
    expect(resolveReviewer(config(), "review: claude code", "codex")).toBe("claude-code");
  });

  it("an unrecognized name in a rules line falls through instead of cancelling the default", () => {
    // Previously this returned null and silently disabled review everywhere.
    expect(resolveReviewer(config(), "review: gemini", "codex")).toBe("codex");
  });
});

describe("reviewerSource — status must explain where the setting came from", () => {
  it("names the level that decided it", () => {
    expect(reviewerSource(config("cursor"), "", "codex")).toBe("this project");
    expect(reviewerSource(config(), "review: codex", null)).toBe("a rules file");
    expect(reviewerSource(config(), "", "codex")).toContain("every project");
    expect(reviewerSource(config(), "", null)).toBe("not set");
  });
});

describe("chooseReviewer — 'every change' must not become 'most changes'", () => {
  const installed = async (id: "claude-code" | "cursor" | "codex"): Promise<boolean> =>
    isAgentInstalled(AGENT_CLIS[id].bin);

  it("substitutes another vendor when the configured reviewer wrote the code", async () => {
    if (!(await installed("codex")) || !(await installed("claude-code"))) return; // env-dependent
    const r = await chooseReviewer("codex", "codex");
    expect(r).not.toBeNull();
    expect(r!.id).not.toBe("codex"); // never reviews its own work
    expect(r!.substituted).toBe(true);
  });

  it("uses the configured reviewer when it didn't write the code", async () => {
    if (!(await installed("codex"))) return;
    const r = await chooseReviewer("codex", "claude-code");
    expect(r).toEqual({ id: "codex", substituted: false });
  });
});
