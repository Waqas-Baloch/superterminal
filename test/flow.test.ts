import { describe, it, expect } from "vitest";
import { parseFlow, describeStep } from "../src/core/flow";

describe("parseFlow — deterministic multi-step planning", () => {
  it("splits on 'then' and routes each step to its named agent", () => {
    const steps = parseFlow(
      "audit the auth module with claude, then implement the fixes with cursor, then review the diff with codex",
    );
    expect(steps).toEqual([
      { task: "audit the auth module", agent: "claude-code", skill: null },
      { task: "implement the fixes", agent: "cursor", skill: null },
      { task: "review the diff", agent: "codex", skill: null },
    ]);
  });

  it("picks up skills in either syntax", () => {
    expect(parseFlow("audit auth with claude using the security skill")[0]).toEqual({
      task: "audit auth",
      agent: "claude-code",
      skill: "security",
    });
    // the parenthesised ".md skill" form
    expect(parseFlow("conduct marketing research in claude using (marketing-research.md skill)")[0]).toEqual({
      task: "conduct marketing research",
      agent: "claude-code",
      skill: "marketing-research",
    });
  });

  it("maps agent aliases (chatgpt/gpt → codex, claude code → claude-code)", () => {
    expect(parseFlow("write tests with chatgpt")[0].agent).toBe("codex");
    expect(parseFlow("write tests with gpt")[0].agent).toBe("codex");
    expect(parseFlow("write tests with claude code")[0].agent).toBe("claude-code");
  });

  it("leaves the agent unset when none is named (uses whatever is connected)", () => {
    expect(parseFlow("refactor the cart module")[0]).toEqual({
      task: "refactor the cart module",
      agent: null,
      skill: null,
    });
  });

  it("handles newline- and semicolon-separated steps, and strips filler", () => {
    const steps = parseFlow("first plan the change with claude\nthen apply it with cursor; finally run the tests");
    expect(steps.map((s) => s.task)).toEqual(["plan the change", "apply it", "run the tests"]);
    expect(steps.map((s) => s.agent)).toEqual(["claude-code", "cursor", null]);
  });
});

describe("flow parsing — phrasings people actually type", () => {
  it("drops the dangling 'and' from '…with claude and then…'", () => {
    const steps = parseFlow("update the hero with claude and then verify with codex");
    expect(steps.map((s) => s.task)).toEqual(["update the hero", "verify"]);
    expect(steps.map((s) => s.agent)).toEqual(["claude-code", "codex"]);
  });

  it("splits on sentences as well as 'then'", () => {
    const steps = parseFlow("analyze the code with claude. then refactor with cursor");
    expect(steps).toHaveLength(2);
    expect(steps[1].agent).toBe("cursor");
  });

  it("keeps a filename in the step task", () => {
    const steps = parseFlow("check index.html with claude, then improve it with cursor");
    expect(steps[0].task).toBe("check index.html");
  });
});

describe("describeStep — the preview must name the agent that will really run", () => {
  it("shows the substitute, not the agent the step asked for", () => {
    const [step] = parseFlow("fix it with cursor");
    expect(step.agent).toBe("cursor");
    // Cursor isn't installed; codex stands in — the plan must say codex.
    expect(describeStep(step, 1, "ChatGPT (Codex)")).toBe("2. fix it  → ChatGPT (Codex)");
  });

  it("names the connected agent when the step named none", () => {
    const [step] = parseFlow("tidy the header");
    expect(describeStep(step, 0, "Claude Code")).toBe("1. tidy the header  → Claude Code");
  });
});
