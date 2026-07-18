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

  it("treats plain text as a task", () => {
    expect(interpret("make the header sticky")).toEqual({ type: "task", task: "make the header sticky" });
  });
});
