import { describe, it, expect } from "vitest";
import { canAnimate } from "../src/report/spinner";

// A terminal reporting isTTY=true with columns=0 is real (ptys with no
// negotiated size). Animating there made ora emit hundreds of cursor-up +
// erase sequences per frame — ~5MB/s, measured at 251MB in one short run.
describe("canAnimate — never do cursor math against an unknown width", () => {
  it("animates in a normal terminal", () => {
    expect(canAnimate({ isTTY: true, columns: 80 })).toBe(true);
    expect(canAnimate({ isTTY: true, columns: 1 })).toBe(true);
  });

  it("refuses when a TTY reports zero or missing width", () => {
    expect(canAnimate({ isTTY: true, columns: 0 })).toBe(false);
    expect(canAnimate({ isTTY: true })).toBe(false);
    expect(canAnimate({ isTTY: true, columns: -1 })).toBe(false);
  });

  it("refuses when there's no terminal at all (pipes, CI logs)", () => {
    expect(canAnimate({ isTTY: false, columns: 80 })).toBe(false);
    expect(canAnimate({})).toBe(false);
  });
});
