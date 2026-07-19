import { describe, it, expect } from "vitest";
import { parseFlow } from "../src/core/flow";

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
