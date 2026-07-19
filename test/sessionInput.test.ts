import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { filterCommands, highlightFiles, applyEdit, readSessionLine, type SlashCommand } from "../src/report/sessionInput";

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

describe("highlightFiles — see which file Super Terminal found, before you send", () => {
  const exists = (t: string): boolean => t === "landing-page.md" || t === "src/hero.tsx";

  it("tints a filename that exists in the repo", () => {
    const out = highlightFiles("review the page using landing-page.md", exists);
    expect(out).toContain("\x1b[38;2;150;220;255mlanding-page.md\x1b[39m");
  });

  it("leaves a filename that doesn't exist plain — no false promise", () => {
    expect(highlightFiles("check ghost.md for issues", exists)).toBe("check ghost.md for issues");
  });

  it("leaves ordinary words alone", () => {
    expect(highlightFiles("make the hero bigger", exists)).toBe("make the hero bigger");
  });

  it("handles a path, not just a bare name", () => {
    expect(highlightFiles("edit src/hero.tsx", exists)).toContain("\x1b[38;2;150;220;255msrc/hero.tsx");
  });

  it("is a no-op when no matcher is supplied", () => {
    expect(highlightFiles("using landing-page.md")).toBe("using landing-page.md");
  });

  it("adds no visible width, so the cursor stays put", () => {
    const raw = "using landing-page.md now";
    const painted = highlightFiles(raw, exists);
    expect(painted.replace(/\x1b\[[0-9;]*m/g, "")).toBe(raw);
  });
});

describe("cursor editing — a prompt you can actually fix mid-sentence", () => {
  const k = (name: string, mod: Partial<{ ctrl: boolean; meta: boolean }> = {}) =>
    ({ name, ctrl: false, meta: false, shift: false, sequence: "", ...mod }) as any;
  const edit = (s: { buf: string; pos: number }, key: any, str?: string) => applyEdit(s, key, str)!;

  it("moves left and right without changing the text", () => {
    const s = { buf: "hello", pos: 5 };
    expect(edit(s, k("left"))).toEqual({ buf: "hello", pos: 4 });
    expect(edit({ buf: "hello", pos: 2 }, k("right"))).toEqual({ buf: "hello", pos: 3 });
  });

  it("stops at both ends instead of running off", () => {
    expect(edit({ buf: "hi", pos: 0 }, k("left")).pos).toBe(0);
    expect(edit({ buf: "hi", pos: 2 }, k("right")).pos).toBe(2);
  });

  it("inserts typed characters AT the caret, not at the end", () => {
    // The old input appended blindly — this is the bug being fixed.
    expect(edit({ buf: "helo", pos: 3 }, k(""), "l")).toEqual({ buf: "hello", pos: 4 });
  });

  it("backspaces the character before the caret, keeping the tail", () => {
    expect(edit({ buf: "helllo", pos: 4 }, k("backspace"))).toEqual({ buf: "hello", pos: 3 });
    expect(edit({ buf: "abc", pos: 0 }, k("backspace"))).toEqual({ buf: "abc", pos: 0 });
  });

  it("forward-deletes with Delete", () => {
    expect(edit({ buf: "hello", pos: 0 }, k("delete"))).toEqual({ buf: "ello", pos: 0 });
    expect(edit({ buf: "hi", pos: 2 }, k("delete"))).toEqual({ buf: "hi", pos: 2 });
  });

  it("jumps by word with ⌥←/⌥→", () => {
    expect(edit({ buf: "fix the hero", pos: 12 }, k("left", { meta: true })).pos).toBe(8);
    expect(edit({ buf: "fix the hero", pos: 0 }, k("right", { meta: true })).pos).toBe(3);
  });

  it("supports Home/End and the shell shortcuts", () => {
    expect(edit({ buf: "abc", pos: 3 }, k("home")).pos).toBe(0);
    expect(edit({ buf: "abc", pos: 0 }, k("end")).pos).toBe(3);
    expect(edit({ buf: "abc", pos: 3 }, k("a", { ctrl: true })).pos).toBe(0);
    expect(edit({ buf: "abc", pos: 0 }, k("e", { ctrl: true })).pos).toBe(3);
    expect(edit({ buf: "keep this", pos: 4 }, k("k", { ctrl: true }))).toEqual({ buf: "keep", pos: 4 });
    expect(edit({ buf: "drop that", pos: 9 }, k("w", { ctrl: true }))).toEqual({ buf: "drop ", pos: 5 });
    expect(edit({ buf: "all gone", pos: 8 }, k("u", { ctrl: true }))).toEqual({ buf: "", pos: 0 });
  });

  it("returns null for keys it doesn't own, so Enter/Esc still reach the caller", () => {
    expect(applyEdit({ buf: "x", pos: 1 }, k("return"))).toBeNull();
    expect(applyEdit({ buf: "x", pos: 1 }, k("escape"))).toBeNull();
  });
});
