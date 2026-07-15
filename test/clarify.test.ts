import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildQuestions, compileTask, rankingIsConfident } from "../src/core/clarify";
import type { Selection } from "../src/core/selector";
import type { Anchor } from "../src/core/ranking/types";

let dir: string;

function makeSelection(paths: string[], task: string): Selection {
  return {
    task,
    primary: paths.map((p) => ({ path: p, score: 1, tokens: 100, reasons: ["matched"] })),
    supporting: [],
    optional: [],
    totalTokens: 100,
    budget: 30_000,
    taskType: "ui",
    taskConfidence: 0.8,
    anchors: [],
  };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-clarify-"));
  await fs.writeFile(
    path.join(dir, "index.html"),
    [
      "<body>",
      '<nav><button class="subscribe">Subscribe</button></nav>',
      '<section id="pricing"><button class="buy">Buy now</button></section>',
      '<footer><button class="contact">Contact us</button></footer>',
      "</body>",
    ].join("\n"),
  );
  await fs.writeFile(path.join(dir, "styles.css"), ".subscribe { color: white; }\n.buy { color: black; }\n");
  await fs.writeFile(path.join(dir, "theme.css"), ":root { --primary: #333; }\n");
  await fs.writeFile(path.join(dir, "single.html"), '<body><button class="only">Only one</button></body>');

  // A real-world home page: the named target ("Try Now") is a LINK, and the
  // only <button>s on the page are unrelated. Naming it must not make Glint
  // offer those buttons.
  await fs.writeFile(
    path.join(dir, "home.html"),
    [
      "<body>",
      '  <nav><a class="cta" href="/signup">Try Now</a></nav>',
      '  <section id="pricing">',
      '    <button class="billing-opt is-active" type="button">Monthly</button>',
      '    <button class="billing-opt" type="button">Annually</button>',
      '    <button type="submit" class="plan-btn">Join</button>',
      "  </section>",
      "</body>",
    ].join("\n"),
  );

  // Two buttons with identical copy in different landmarks — the exact case
  // where "remove This Testing" would otherwise nuke both.
  await fs.writeFile(
    path.join(dir, "dupes.html"),
    [
      "<body>",
      '  <nav><button class="cta">This Testing</button></nav>',
      "  <main><p>Some real content here</p></main>",
      '  <footer><button class="cta">This Testing</button></footer>',
      "</body>",
    ].join("\n"),
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("buildQuestions", () => {
  it("asks which element when a task term matches several candidates", async () => {
    const task = "change the button in index.html to black";
    const questions = await buildQuestions(task, makeSelection(["index.html"], task), dir);
    const q = questions.find((q) => q.key === "target_button");

    expect(q).toBeDefined();
    expect(q!.choices.length).toBeGreaterThanOrEqual(4); // 3 buttons + "All of them"
    expect(q!.choices.some((c) => c.title.includes("Subscribe"))).toBe(true);
    expect(q!.choices.some((c) => c.title.includes("Buy now"))).toBe(true);
    expect(q!.choices.at(-1)!.value).toBe("__all__");
  });

  it("stays silent when the prompt already discriminates (well-written task)", async () => {
    const task = "change the buy button to black";
    const questions = await buildQuestions(task, makeSelection(["index.html"], task), dir);
    expect(questions.find((q) => q.key === "target_button")).toBeUndefined();
  });

  it("narrows the choices when the task partially discriminates", async () => {
    // "subscribe" and "contact" both match task words → ask, but only among those two
    const task = "change the subscribe and contact button to black";
    const questions = await buildQuestions(task, makeSelection(["index.html"], task), dir);
    const q = questions.find((q) => q.key === "target_button");
    expect(q).toBeDefined();
    const titles = q!.choices.map((c) => c.title).join("\n");
    expect(titles).toContain("Subscribe");
    expect(titles).toContain("Contact");
    expect(titles).not.toContain("Buy now");
  });

  it("stays silent when the term is unambiguous", async () => {
    const task = "change the button to black";
    const questions = await buildQuestions(task, makeSelection(["single.html"], task), dir);
    expect(questions.find((q) => q.key === "target_button")).toBeUndefined();
  });

  it("asks about file scope only when several files are targeted and the task names none", async () => {
    const vague = "make the primary color darker";
    const withFiles = await buildQuestions(vague, makeSelection(["index.html", "styles.css", "theme.css"], vague), dir);
    expect(withFiles.find((q) => q.key === "file_scope")).toBeDefined();

    // Only 2 targets — the ranking ordered them; don't ask.
    const few = await buildQuestions(vague, makeSelection(["index.html", "styles.css"], vague), dir);
    expect(few.find((q) => q.key === "file_scope")).toBeUndefined();

    const named = "make the primary color darker in index.html";
    const withNamed = await buildQuestions(named, makeSelection(["index.html", "styles.css", "theme.css"], named), dir);
    expect(withNamed.find((q) => q.key === "file_scope")).toBeUndefined();
  });

  it("refine compiles specific choices into constraints", async () => {
    const task = "change the button to black";
    const questions = await buildQuestions(task, makeSelection(["index.html"], task), dir);
    const q = questions.find((q) => q.key === "target_button")!;

    const specific = q.refine(['index.html:3 → <button class="buy">Buy now']);
    expect(specific).toContain("Buy now");
    expect(specific).toContain("Do not modify any other button");

    expect(q.refine(["__all__"])).toContain("every button");
    expect(q.refine([])).toBeNull();
  });
});

describe("a well-specified task asks nothing", () => {
  it("does not offer unrelated buttons when the named target is a link", async () => {
    // "Try Now" is an <a>, not a <button>. The old tag-word fallback listed
    // every <button> on the page because the discriminator matched none.
    const task = "remove Try now Button from home page";
    const questions = await buildQuestions(task, makeSelection(["home.html"], task), dir);
    expect(questions).toEqual([]);
  });

  it("does not ask which file when the task named the page", async () => {
    // Three candidate files and no dominant anchor, but "index page" pins it.
    const task = "remove the Subscribe button from index page";
    const questions = await buildQuestions(task, makeSelection(["index.html", "styles.css", "theme.css"], task), dir);
    expect(questions.find((q) => q.key === "file_scope")).toBeUndefined();
    expect(questions).toEqual([]);
  });
});

describe("duplicate-target detection — the same copy in several places", () => {
  it("asks which occurrence when a quoted target appears more than once", async () => {
    const task = 'remove the "This Testing" button';
    const questions = await buildQuestions(task, makeSelection(["dupes.html"], task), dir);
    const q = questions.find((q) => q.key === "target_location");

    expect(q).toBeDefined();
    expect(q!.choices.length).toBe(3); // two occurrences + "All of them"
    // The two occurrences are distinguishable by their enclosing landmark.
    const titles = q!.choices.map((c) => c.title).join("\n");
    expect(titles).toContain("nav");
    expect(titles).toContain("footer");
    expect(q!.choices.at(-1)!.value).toBe("__all__");
  });

  it("fires without quotes or a tag word, when the task names the copy", async () => {
    const task = "remove This Testing";
    const questions = await buildQuestions(task, makeSelection(["dupes.html"], task), dir);
    expect(questions.find((q) => q.key === "target_location")).toBeDefined();
    // The generic tag-word question must NOT also fire — the copy question wins.
    expect(questions.find((q) => q.key === "target_button")).toBeUndefined();
  });

  it("fires even when the file is a confident single anchor (file-confidence ≠ target-confidence)", async () => {
    const task = 'remove "This Testing"';
    const sel = makeSelection(["dupes.html"], task);
    sel.anchors = [{ path: "dupes.html", score: 0.9 }]; // dominant → file is certain
    expect(rankingIsConfident(sel)).toBe(true);
    const questions = await buildQuestions(task, sel, dir);
    expect(questions.find((q) => q.key === "target_location")).toBeDefined();
  });

  it("compiles a location-scoped constraint, or an all-occurrences one", async () => {
    const task = "remove This Testing";
    const q = (await buildQuestions(task, makeSelection(["dupes.html"], task), dir)).find(
      (q) => q.key === "target_location",
    )!;
    const navValue = q.choices.find((c) => c.title.includes("nav"))!.value;

    const scoped = q.refine([navValue])!;
    expect(scoped).toContain("<nav>"); // targets the nav one by structural anchor
    expect(scoped.toLowerCase()).toContain("identical"); // warns the copies are identical
    expect(scoped).toContain("Do NOT touch"); // protects the other occurrence(s)
    expect(scoped).toContain("footer"); // names the footer copy as the one to keep

    expect(q.refine(["__all__"])).toContain("all 2");
    expect(q.refine([])).toBeNull();
  });

  it("stays silent when each element's copy is unique", async () => {
    const task = "change the button in index.html to black";
    const questions = await buildQuestions(task, makeSelection(["index.html"], task), dir);
    expect(questions.find((q) => q.key === "target_location")).toBeUndefined();
  });
});

describe("rankingIsConfident — the gate that keeps Glint from over-asking", () => {
  function withAnchors(anchors: Anchor[], primaryCount: number): Selection {
    const sel = makeSelection(Array.from({ length: primaryCount }, (_, i) => `f${i}.tsx`), "task");
    sel.anchors = anchors;
    return sel;
  }

  it("trusts a clearly dominant anchor and does not ask", () => {
    expect(rankingIsConfident(withAnchors([{ path: "a.tsx", score: 0.8 }], 1))).toBe(true);
    expect(rankingIsConfident(withAnchors([{ path: "a.tsx", score: 0.5 }, { path: "b.tsx", score: 0.2 }], 2))).toBe(true);
  });

  it("asks when the top anchors are near-tied (no clear target)", () => {
    expect(rankingIsConfident(withAnchors([{ path: "a.tsx", score: 0.45 }, { path: "b.tsx", score: 0.42 }], 2))).toBe(false);
  });

  it("asks when there is no anchor at all", () => {
    expect(rankingIsConfident(withAnchors([], 2))).toBe(false);
  });

  it("asks when many files are edit targets even if one anchor leads", () => {
    expect(rankingIsConfident(withAnchors([{ path: "a.tsx", score: 0.8 }], 5))).toBe(false);
  });
});

describe("compileTask", () => {
  it("appends refinements as clarified details", () => {
    const compiled = compileTask("change the button to black", [
      'The "button" means exactly: index.html:3 → <button class="buy">Buy now. Do not modify any other button.',
      "Only make changes in: index.html. Treat other files as read-only context.",
    ]);
    expect(compiled).toContain("change the button to black");
    expect(compiled).toContain("Clarified details:");
    expect(compiled.split("\n- ").length).toBe(3);
  });

  it("returns the original task when there is nothing to add", () => {
    expect(compileTask("some task", [])).toBe("some task");
  });
});
