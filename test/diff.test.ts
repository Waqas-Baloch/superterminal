import { describe, it, expect } from "vitest";
import { semanticDiff } from "../src/core/semantic/diff";

describe("semantic diff — review by meaning, not lines", () => {
  it("flags a removed symbol whose callers are now unresolved (the dangerous one)", () => {
    const before = new Map([
      ["src/util.ts", "export function formatDate(d: Date) { return d.toISOString(); }\n"],
      ["src/a.ts", 'import { formatDate } from "./util";\nexport const a = (d: Date) => formatDate(d);\n'],
    ]);
    const after = new Map([
      ["src/util.ts", "\n"], // agent deleted it
      ["src/a.ts", 'import { formatDate } from "./util";\nexport const a = (d: Date) => formatDate(d);\n'],
    ]);
    const changes = semanticDiff(before, after);
    const removed = changes.find((c) => c.kind === "removed" && c.summary.includes("formatDate"));
    expect(removed).toBeDefined();
    expect(removed!.warn).toBe(true);
    expect(removed!.summary).toContain("unresolved");
  });

  it("does not warn when a removed symbol had no remaining references", () => {
    const before = new Map([["src/util.ts", "export function lone() { return 1; }\nexport const keep = 2;\n"]]);
    const after = new Map([["src/util.ts", "export const keep = 2;\n"]]);
    const changes = semanticDiff(before, after);
    const removed = changes.find((c) => c.summary.includes("lone"));
    expect(removed?.warn).toBe(false);
  });

  it("summarizes an element text change as X → Y", () => {
    const before = new Map([["index.html", "<body><nav><button>Try Now</button></nav></body>"]]);
    const after = new Map([["index.html", "<body><nav><button>Get Started</button></nav></body>"]]);
    const changes = semanticDiff(before, after);
    const retext = changes.find((c) => c.kind === "retext");
    expect(retext?.summary).toContain('"Try Now" → "Get Started"');
  });

  it("flags a file that changed on disk but has no semantic change (reformat only)", () => {
    const before = new Map([["src/util.ts", "export function f(){return 1}\n"]]);
    const after = new Map([["src/util.ts", "export function f() {\n  return 1;\n}\n"]]); // reindented, same meaning
    const changes = semanticDiff(before, after);
    const reformat = changes.find((c) => c.kind === "reformat");
    expect(reformat).toBeDefined();
    expect(reformat!.warn).toBe(true);
  });

  it("reports nothing when nothing changed", () => {
    const same = new Map([["src/util.ts", "export const x = 1;\n"]]);
    expect(semanticDiff(same, new Map(same))).toEqual([]);
  });
});
