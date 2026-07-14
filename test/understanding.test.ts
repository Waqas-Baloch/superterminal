import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildIntentFrame,
  classifyBand,
  detectAmbiguity,
  detectDuplicate,
  readSelectionContents,
  resolutionConfidence,
  sectionSummary,
  type AmbiguityReport,
  type Instance,
} from "../src/core/understanding";
import type { Selection } from "../src/core/selector";
import type { Anchor } from "../src/core/ranking/types";

function selectionWith(anchors: Anchor[], primaryCount = 1, task = "task"): Selection {
  return {
    task,
    primary: Array.from({ length: primaryCount }, (_, i) => ({ path: `f${i}.tsx`, score: 1, tokens: 10, reasons: ["m"] })),
    supporting: [],
    optional: [],
    totalTokens: 10,
    budget: 30_000,
    taskType: "ui",
    taskConfidence: 0.8,
    anchors,
  };
}
const confident = () => selectionWith([{ path: "a.tsx", score: 0.9 }], 1);

function fakeInstance(file: string, line: number, landmark: string, text = "This Testing"): Instance {
  const where = landmark ? ` · in <${landmark}>` : "";
  return { file, line, landmark, text, value: `${file}:${line}${where}`, label: `${file}:${line}${where} → ${text}` };
}
function report(over: Partial<AmbiguityReport>): AmbiguityReport {
  return { duplicate: null, styleUnderspecified: false, ...over };
}

describe("intent frame builder", () => {
  it("classifies destructive actions and flags the risk", () => {
    for (const verb of ["remove", "delete", "get rid of", "hide"]) {
      const f = buildIntentFrame(`${verb} the hero banner`);
      expect(f.risk).toBe("destructive");
    }
    expect(buildIntentFrame("remove the CTA").action).toBe("remove");
  });

  it("classifies restyle as style-risk and add as additive", () => {
    expect(buildIntentFrame("make the button padding bigger").risk).toBe("style");
    expect(buildIntentFrame("add a newsletter signup form").risk).toBe("additive");
    expect(buildIntentFrame("add a newsletter signup form").action).toBe("add");
  });

  it("extracts quoted targets, scope hints, and modifiers", () => {
    const f = buildIntentFrame('remove the primary "Try Now" button from the footer');
    expect(f.quotedTargets).toContain("Try Now");
    expect(f.scopeHints).toContain("footer");
    expect(f.modifiers).toContain("primary");
  });
});

describe("duplicate detector", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-understand-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      [
        "<body>",
        '  <nav><button class="cta">Try Now</button></nav>',
        "  <main><p>Real content</p></main>",
        '  <footer><button class="cta">Try Now</button></footer>',
        "</body>",
      ].join("\n"),
    );
    await fs.writeFile(path.join(dir, "solo.html"), '<body><button class="only">Unique Copy</button></body>');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds the same copy in two landmarks and marks it cross-section", async () => {
    const sel = selectionWith([{ path: "index.html", score: 0.9 }], 1);
    sel.primary = [{ path: "index.html", score: 1, tokens: 10, reasons: ["m"] }];
    const contents = await readSelectionContents(sel, dir);

    const dup = detectDuplicate("remove the Try Now button", contents);
    expect(dup).not.toBeNull();
    expect(dup!.instances).toHaveLength(2);
    expect(dup!.crossSection).toBe(true);
    expect(dup!.instances.map((i) => i.landmark)).toEqual(expect.arrayContaining(["nav", "footer"]));
  });

  it("stays null when the copy is unique", async () => {
    const sel = selectionWith([], 1);
    sel.primary = [{ path: "solo.html", score: 1, tokens: 10, reasons: ["m"] }];
    const contents = await readSelectionContents(sel, dir);
    expect(detectDuplicate("remove the Unique Copy button", contents)).toBeNull();
  });

  it("flags underspecified styling only for restyle requests", async () => {
    const sel = selectionWith([], 1);
    sel.primary = [{ path: "solo.html", score: 1, tokens: 10, reasons: ["m"] }];
    const contents = await readSelectionContents(sel, dir);
    expect(detectAmbiguity("make the button nicer", buildIntentFrame("make the button nicer"), contents).styleUnderspecified).toBe(true);
    expect(detectAmbiguity("make the button red", buildIntentFrame("make the button red"), contents).styleUnderspecified).toBe(false);
    expect(detectAmbiguity("remove the button", buildIntentFrame("remove the button"), contents).styleUnderspecified).toBe(false);
  });
});

describe("four-band classifier", () => {
  const dupCrossSection = {
    phrase: "Try Now",
    instances: [fakeInstance("index.html", 2, "nav"), fakeInstance("index.html", 4, "footer")],
    crossFile: false,
    crossSection: true,
  };

  it("RED: a destructive edit colliding with identical targets in different sections", () => {
    const d = classifyBand(buildIntentFrame("remove Try Now"), confident(), report({ duplicate: dupCrossSection }));
    expect(d.band).toBe("red");
    expect(d.reason).toContain("Try Now");
  });

  it("ORANGE: a non-destructive edit with duplicate targets — ask, don't block", () => {
    const d = classifyBand(buildIntentFrame("rename Try Now to Start"), confident(), report({ duplicate: dupCrossSection }));
    expect(d.band).toBe("orange");
  });

  it("ORANGE: several candidate files and the ranking can't single one out", () => {
    const d = classifyBand(buildIntentFrame("update the primary color"), selectionWith([], 4), report({}));
    expect(d.band).toBe("orange");
  });

  it("YELLOW: target is clear but styling is underspecified", () => {
    const d = classifyBand(buildIntentFrame("make the button nicer"), confident(), report({ styleUnderspecified: true }));
    expect(d.band).toBe("yellow");
  });

  it("GREEN: one dominant target, no ambiguity", () => {
    const d = classifyBand(buildIntentFrame("rename the header to Home"), confident(), report({}));
    expect(d.band).toBe("green");
  });
});

describe("resolution confidence + section summary", () => {
  it("is high for a runaway winner and low for a near-tie", () => {
    const runaway = resolutionConfidence(selectionWith([{ path: "a", score: 0.9 }, { path: "b", score: 0.1 }]));
    const tie = resolutionConfidence(selectionWith([{ path: "a", score: 0.45 }, { path: "b", score: 0.43 }]));
    expect(runaway).toBeGreaterThan(tie);
    expect(resolutionConfidence(selectionWith([]))).toBeLessThan(0.3);
  });

  it("summarizes where duplicate copies live in plain language", () => {
    expect(sectionSummary([fakeInstance("i.html", 2, "nav"), fakeInstance("i.html", 9, "footer")])).toBe(
      "the navbar and the footer",
    );
  });
});
