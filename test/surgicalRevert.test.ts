import { describe, it, expect } from "vitest";
import { surgicalRevert } from "../src/core/surgicalRevert";

const before = [
  "<!doctype html><html><body>", // 1
  '  <nav><button class="cta">Try Now</button></nav>', // 2  ← change this
  "  <main><h1>Welcome</h1></main>", // 3
  '  <footer id="support"><button class="cta">Try Now</button></footer>', // 4  ← KEEP this
  "</body></html>", // 5
].join("\n");

describe("surgical revert — undo only the out-of-scope hunk", () => {
  it("keeps the intended nav change and restores the footer the agent shouldn't have touched", () => {
    // Agent did a global replace: both "Try Now" → "Get Started".
    const after = before.replace(/Try Now/g, "Get Started");
    const { content, reverted } = surgicalRevert(before, after, [4]); // keep line 4 (footer)

    expect(reverted).toBe(1);
    expect(content).toContain('<nav><button class="cta">Get Started</button></nav>'); // change kept
    expect(content).toContain('<footer id="support"><button class="cta">Try Now</button></footer>'); // footer restored
  });

  it("restores a footer the agent deleted entirely, keeping the nav removal the user wanted", () => {
    // User asked to remove the NAV button; agent removed both.
    const after = before.replace('  <nav><button class="cta">Try Now</button></nav>\n', "").replace(
      '  <footer id="support"><button class="cta">Try Now</button></footer>',
      "  <footer id=\"support\"></footer>",
    );
    const { content, reverted } = surgicalRevert(before, after, [4]);
    expect(reverted).toBe(1);
    expect(content).not.toContain("<nav>"); // intended removal preserved
    expect(content).toContain('<footer id="support"><button class="cta">Try Now</button></footer>'); // footer back
  });

  it("is a no-op when the kept region wasn't touched", () => {
    const after = before.replace('<nav><button class="cta">Try Now</button></nav>', '<nav><button class="cta">Go</button></nav>');
    const { content, reverted } = surgicalRevert(before, after, [4]);
    expect(reverted).toBe(0);
    expect(content).toBe(after);
  });

  it("degrades to a whole-file revert when the file was rewritten as one hunk", () => {
    const after = "completely different content\nnothing in common at all\n";
    const { content, reverted } = surgicalRevert(before, after, [4]);
    expect(reverted).toBe(1);
    expect(content).toBe(before); // safe: whole file restored, never a broken merge
  });
});
