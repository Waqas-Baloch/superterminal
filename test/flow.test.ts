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

describe("agent routing — the step must run on the agent you named", () => {
  const routes = (input: string) => parseFlow(input).map((s) => s.agent);

  it("is case-insensitive across every spelling", () => {
    expect(routes("a with Claude Code, then b with ChatGPT")).toEqual(["claude-code", "codex"]);
    expect(routes("a with CLAUDE, then b with CODEX")).toEqual(["claude-code", "codex"]);
    expect(routes("a with claude, then b with chatgpt")).toEqual(["claude-code", "codex"]);
    expect(routes("a with ChatGPT Codex, then b with claude-code")).toEqual(["codex", "claude-code"]);
    expect(routes("a with GPT, then b with OpenAI")).toEqual(["codex", "codex"]);
  });

  it("reads 'use X to …' and 'ask X to …', not just 'with X'", () => {
    expect(routes("Use Claude Code to review it then use ChatGPT to fix it")).toEqual(["claude-code", "codex"]);
    expect(routes("ask claude to audit, then ask codex to fix")).toEqual(["claude-code", "codex"]);
    expect(routes("have Cursor refactor it then let Claude Code verify")).toEqual(["cursor", "claude-code"]);
  });

  it("reads 'X does …' and 'X: …'", () => {
    expect(routes("claude reviews the page, then codex implements fixes")).toEqual(["claude-code", "codex"]);
    expect(routes("codex: fix the header, then claude: verify it")).toEqual(["codex", "claude-code"]);
  });

  it("strips the agent phrase out of the task text", () => {
    expect(parseFlow("Use Claude Code to review index.html")[0].task).toBe("review index.html");
    expect(parseFlow("ask codex to fix it")[0].task).toBe("fix it");
    expect(parseFlow("codex: fix the header")[0].task).toBe("fix the header");
  });

  it("splits on arrows and numbered lists, not just 'then'", () => {
    expect(routes("1. review with claude 2. fix with codex")).toEqual(["claude-code", "codex"]);
    expect(routes("review with claude -> fix with codex")).toEqual(["claude-code", "codex"]);
  });

  it("does NOT route on a bare mention — that's the subject, not the router", () => {
    // Would otherwise hijack the step to Cursor / Codex and run the wrong agent.
    expect(routes("review with claude, then fix the cursor position in the editor")).toEqual([
      "claude-code",
      null,
    ]);
    expect(routes("review the gpt prompt templates")).toEqual([null]);
    expect(routes("make the hero bigger")).toEqual([null]);
  });
});
