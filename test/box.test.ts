import { describe, it, expect } from "vitest";
import { renderBox, BOX_WIDTH } from "../src/report/box";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderBox", () => {
  it("renders all lines at exactly the box width", () => {
    const lines = renderBox("HTML — 2 files", [
      { left: "index.html", right: "~74 tok" },
      { left: "  matched: heading · full content" },
      { left: "about.html", right: "~1.2k tok" },
    ]);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBe(BOX_WIDTH);
    }
  });

  it("uses rounded corners and a titled top border", () => {
    const [top, , bottom] = renderBox("CSS — 1 file", [{ left: "style.css" }]).map(stripAnsi);
    expect(top.startsWith("╭─ CSS — 1 file ")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
    expect(bottom.startsWith("╰")).toBe(true);
    expect(bottom.endsWith("╯")).toBe(true);
  });

  it("truncates long paths from the left instead of overflowing", () => {
    const longPath = "src/very/deeply/nested/directory/structure/with/a/really/long/component/name/File.tsx";
    const lines = renderBox("TypeScript — 1 file", [{ left: longPath, right: "~9.9k tok" }]);
    const row = stripAnsi(lines[1]);
    expect(row.length).toBe(BOX_WIDTH);
    expect(row).toContain("…");
    expect(row).toContain("File.tsx");
  });

  it("renders a solid fill with notched block corners in filled mode", () => {
    const lines = renderBox(
      "HTML — 1 file",
      [
        { left: "index.html", right: "~74 tok", kind: "main" },
        { left: "  matched: heading · full content", kind: "sub" },
      ],
      BOX_WIDTH,
      "filled",
    );
    const stripped = lines.map(stripAnsi);
    expect(stripped[0].startsWith("▗")).toBe(true);
    expect(stripped[0].endsWith("▖")).toBe(true);
    expect(stripped[1]).toContain("HTML — 1 file");
    expect(stripped.at(-1)!.startsWith("▝")).toBe(true);
    expect(stripped.at(-1)!.endsWith("▘")).toBe(true);
    for (const line of stripped) {
      expect(line.length).toBe(BOX_WIDTH);
    }
  });
});
