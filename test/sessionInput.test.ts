import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { filterCommands, readSessionLine, type SlashCommand } from "../src/report/sessionInput";

const CMDS: SlashCommand[] = [
  { value: "plan", title: "/plan", description: "preview", arg: true },
  { value: "switch", title: "/switch", description: "change agent" },
  { value: "search", title: "/search", description: "switch project" },
  { value: "clear", title: "/clear", description: "clear screen" },
  { value: "exit", title: "/exit", description: "quit" },
];

describe("slash dropdown filtering", () => {
  it("shows every command the instant / is typed", () => {
    expect(filterCommands("/", CMDS)).toHaveLength(CMDS.length);
  });

  it("narrows as you keep typing", () => {
    expect(filterCommands("/s", CMDS).map((c) => c.value)).toEqual(["switch", "search"]);
    expect(filterCommands("/se", CMDS).map((c) => c.value)).toEqual(["search"]);
    expect(filterCommands("/zzz", CMDS)).toEqual([]);
  });

  it("stays closed for plain task text", () => {
    expect(filterCommands("", CMDS)).toEqual([]);
    expect(filterCommands("make the header sticky", CMDS)).toEqual([]);
  });

  it("closes once an argument is being typed", () => {
    // after picking /plan the buffer becomes "/plan " — the menu must get out
    // of the way so the task can be typed.
    expect(filterCommands("/plan ", CMDS)).toEqual([]);
    expect(filterCommands("/plan add a login form", CMDS)).toEqual([]);
  });
});

// The session prompt is the one thing that must never break — if it does, you
// can't type anything. Drive the real keypress handler with a fake TTY.
describe("interactive session line", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  function fakeTTY(): { stdin: EventEmitter; out: () => string } {
    const realIn = process.stdin;
    const realOut = process.stdout;
    const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (v: boolean) => ((stdin.isRaw = v), stdin);
    stdin.resume = () => stdin;
    stdin.pause = () => stdin;
    let buf = "";
    const stdout = { isTTY: true, columns: 100, write: (s: string) => ((buf += s), true) };
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
    restore = () => {
      Object.defineProperty(process, "stdin", { value: realIn, configurable: true });
      Object.defineProperty(process, "stdout", { value: realOut, configurable: true });
    };
    return { stdin, out: () => buf };
  }
  const type = (stdin: EventEmitter, s: string) => {
    for (const ch of s) stdin.emit("keypress", ch, { name: ch, sequence: ch });
  };
  const press = (stdin: EventEmitter, name: string, extra: Record<string, unknown> = {}) =>
    stdin.emit("keypress", undefined, { name, ...extra });

  it("pops the dropdown the instant / is typed, and filters as you type", async () => {
    const { stdin, out } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);

    type(stdin, "/");
    expect(out()).toContain("/switch"); // whole list appeared on the very first keystroke
    expect(out()).toContain("/plan");

    type(stdin, "sw"); // narrows to /switch
    press(stdin, "return");
    await expect(p).resolves.toBe("/switch");
  });

  it("arrow keys move the highlight and Enter picks it", async () => {
    const { stdin } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);
    type(stdin, "/");
    press(stdin, "down"); // /plan -> /switch
    press(stdin, "return");
    await expect(p).resolves.toBe("/switch");
  });

  it("still accepts a plain typed task (no menu in the way)", async () => {
    const { stdin, out } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);
    type(stdin, "make the header sticky");
    expect(out()).not.toContain("/switch"); // dropdown stays closed for free text
    press(stdin, "return");
    await expect(p).resolves.toBe("make the header sticky");
  });

  it("Esc dismisses the dropdown but keeps what you typed", async () => {
    const { stdin } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);
    type(stdin, "/sw");
    press(stdin, "escape");
    press(stdin, "return"); // submits the raw text instead of picking
    await expect(p).resolves.toBe("/sw");
  });

  it("picking an arg command leaves it ready for the argument", async () => {
    const { stdin } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);
    type(stdin, "/plan");
    press(stdin, "return"); // /plan takes an argument → don't submit yet
    type(stdin, "add a login form");
    press(stdin, "return");
    await expect(p).resolves.toBe("/plan add a login form");
  });

  it("backspace reopens the dropdown, Ctrl-C exits", async () => {
    const { stdin } = fakeTTY();
    const p = readSessionLine("Next task", CMDS);
    type(stdin, "/sx"); // no match
    press(stdin, "backspace"); // back to "/s" → matches again
    press(stdin, "return");
    await expect(p).resolves.toBe("/switch");

    const second = fakeTTY();
    const p2 = readSessionLine("Next task", CMDS);
    type(second.stdin, "hello");
    press(second.stdin, "c", { ctrl: true });
    await expect(p2).resolves.toBeUndefined();
  });
});
