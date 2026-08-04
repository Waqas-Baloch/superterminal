import { describe, it, expect } from "vitest";
import { interpret } from "../src/commands/run";

describe("session input router", () => {
  it("opens the command menu for a lone / or an unknown /command", () => {
    expect(interpret("/")).toEqual({ type: "menu" });
    expect(interpret("/sw")).toEqual({ type: "menu" }); // partial / typo → menu, not a task
    expect(interpret("/bogus")).toEqual({ type: "menu" });
  });

  it("still routes fully-typed commands directly (menu is optional, not required)", () => {
    expect(interpret("/switch")).toEqual({ type: "switch" });
    expect(interpret("/search")).toEqual({ type: "search" });
    expect(interpret("/clear")).toEqual({ type: "clear" });
    expect(interpret("/plan add a login form")).toEqual({ type: "plan", task: "add a login form" });
    expect(interpret("switch")).toEqual({ type: "switch" }); // bare word alias
  });

  it("routes flow and compare from inside a session, quotes stripped", () => {
    // This is what broke: `super-t flow "…"` typed at the session prompt was
    // swallowed as a plain task because the parser didn't know "flow".
    expect(interpret('super-t flow "audit auth with claude, then fix it with codex"')).toEqual({
      type: "flow",
      steps: "audit auth with claude, then fix it with codex",
    });
    expect(interpret("/flow audit auth with claude")).toEqual({ type: "flow", steps: "audit auth with claude" });
    expect(interpret('/compare "add rate limiting"')).toEqual({ type: "compare", task: "add rate limiting" });
    expect(interpret('super-t plan "add a login form"')).toEqual({ type: "plan", task: "add a login form" });
  });

  it("treats plain text as a task", () => {
    expect(interpret("make the header sticky")).toEqual({ type: "task", task: "make the header sticky" });
  });
});

// Every `super-t <cmd>` form must be recognised, not just the twelve that were
// whitelisted. Typing `super-t team init` at the session prompt used to fall
// through as a task: it went to an agent, which found several files that could
// plausibly match and stopped to ask which one to edit. The gate did its job on
// a question it should never have been asked, and it cost a full round trip.
describe("session prompt: shell commands are not tasks", () => {
  const OUTSIDE = ["team", "init", "revert", "review", "resume", "tracker", "feedback", "forget", "telemetry"];

  it.each(OUTSIDE)("`super-t %s` is answered, not sent to an agent", (name) => {
    const r = interpret(`super-t ${name}`);
    expect(r.type).toBe("hint");
    expect((r as { message: string }).message).toMatch(/shell command/);
  });

  it("keeps the arguments in the hint, so it can be copied and run", () => {
    const r = interpret("super-t team invite octocat") as { message: string };
    expect(r.message).toContain("super-t team invite octocat");
  });

  it("does not hijack a task that merely starts with a command word", () => {
    // The regex must anchor on the `super-t ` / `/` prefix, not the bare word.
    expect(interpret("init the new payment module").type).toBe("task");
    expect(interpret("review the checkout flow for bugs").type).toBe("task");
    expect(interpret("revert the header to the old design").type).toBe("task");
  });

  it("still routes the commands the session CAN run", () => {
    expect(interpret("super-t doctor").type).toBe("doctor");
    expect(interpret("super-t ticket").type).toBe("ticket");
    expect(interpret("/compare add rate limiting").type).toBe("compare");
  });
});

describe("/skills", () => {
  it("is reachable as a slash command, a bare word, and via super-t", () => {
    expect(interpret("/skills").type).toBe("skills");
    expect(interpret("skills").type).toBe("skills");
    expect(interpret("super-t skills").type).toBe("skills");
    expect(interpret("super-t skills sync").type).toBe("skills");
  });

  it("is not confused with a task about skills", () => {
    expect(interpret("write a skill for the payment module").type).toBe("task");
  });
});

describe("/create", () => {
  it("is reachable bare and with a kind", () => {
    expect(interpret("/create").type).toBe("create");
    expect(interpret("/create skill").type).toBe("create");
    expect((interpret("/create skill") as { what: string }).what).toBe("skill");
    expect((interpret("/create agent code-reviewer") as { what: string }).what).toBe("agent code-reviewer");
    expect(interpret("super-t create skill").type).toBe("create");
  });

  it("does not hijack a task that happens to use the word", () => {
    expect(interpret("create a login form").type).toBe("task");
    expect(interpret("create new endpoints for billing").type).toBe("task");
  });
});
