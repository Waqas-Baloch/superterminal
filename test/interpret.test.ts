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
