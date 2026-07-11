import { describe, it, expect } from "vitest";
import { focusContent } from "../src/core/focus";

const css = [
  ".header { color: black; }",
  "",
  ".nav-link { text-decoration: none; }",
  "",
  ".subscribe-button { background: lime; padding: 4px; }",
  "",
  ".footer { color: gray; }",
  "",
  ".sidebar { width: 200px; }",
  "",
  ".card { border: 1px solid; }",
  "",
  ".table { width: 100%; }",
  "",
  ".modal { position: absolute; }",
  "",
  ".tooltip { font-size: 11px; }",
  "",
  ".badge { border-radius: 9px; }",
  "",
  ".alert { color: red; }",
  "",
  ".tabs { display: flex; }",
  "",
  ".accordion { overflow: hidden; }",
  "",
  ".breadcrumb { font-size: 12px; }",
  "",
  ".pagination { gap: 4px; }",
  "",
  ".avatar { border-radius: 50%; }",
  "",
  ".spinner { animation: spin 1s; }",
  "",
  ".progress { height: 4px; }",
  "",
  ".divider { border-top: 1px; }",
].join("\n");

describe("focusContent", () => {
  it("keeps only regions that mention the task terms", () => {
    const result = focusContent(css, ["subscribe", "button"]);
    expect(result).not.toBeNull();
    const shown = result!.excerpts.map((e) => e.text).join("\n");
    expect(shown).toContain(".subscribe-button");
    expect(shown).not.toContain(".breadcrumb");
    expect(shown).not.toContain(".divider");
    expect(result!.shownLines).toBeLessThan(result!.totalLines);
  });

  it("returns null when nothing matches (file selected structurally)", () => {
    expect(focusContent(css, ["checkout"])).toBeNull();
  });

  it("returns null when matches cover most of the file", () => {
    const dense = Array.from({ length: 20 }, (_, i) => `button-${i} { color: red; }`).join("\n");
    expect(focusContent(dense, ["button"])).toBeNull();
  });

  it("merges overlapping windows into one excerpt", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const withHits = content.replace("line 20", "the button line").replace("line 24", "another button line");
    const result = focusContent(withHits, ["button"]);
    expect(result).not.toBeNull();
    expect(result!.excerpts.length).toBe(1);
  });

  it("excerpts are verbatim file content (safe for str_replace)", () => {
    const result = focusContent(css, ["subscribe"]);
    for (const ex of result!.excerpts) {
      expect(css).toContain(ex.text);
    }
  });
});
