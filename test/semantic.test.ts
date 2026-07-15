import { describe, it, expect } from "vitest";
import { buildElementGraph } from "../src/core/semantic/graph";

describe("semantic element graph — HTML (parse5)", () => {
  it("extracts elements with real landmark, text, and line numbers", () => {
    const html = [
      "<!doctype html><html><body>",
      '  <nav class="top">',
      '    <button class="cta">Try Now</button>',
      "  </nav>",
      '  <section id="pricing">',
      "    <h2>Plans</h2>",
      "  </section>",
      '  <footer><button class="cta">Try Now</button></footer>',
      "</body></html>",
    ].join("\n");
    const g = buildElementGraph(new Map([["index.html", html]]));

    const buttons = g.elements.filter((e) => e.role === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.text === "Try Now")).toBe(true);
    expect(buttons.map((b) => b.landmark).sort()).toEqual(["footer", "nav"]);

    const h2 = g.elements.find((e) => e.role === "h2");
    expect(h2?.landmark).toBe("section#pricing");
    expect(h2?.text).toBe("Plans");
    expect(h2?.line).toBe(6);
  });

  it("skips script/style content", () => {
    const html = '<body><script>const a = "<button>fake</button>";</script><p>Real</p></body>';
    const g = buildElementGraph(new Map([["x.html", html]]));
    expect(g.elements.some((e) => e.role === "script")).toBe(false);
    expect(g.elements.find((e) => e.role === "p")?.text).toBe("Real");
  });
});

describe("semantic element graph — JSX/TSX (ts-morph)", () => {
  it("extracts multi-line React component instances with landmark and component role", () => {
    const jsx = `export function Page() {
  return (
    <div>
      <nav>
        <CtaButton variant="primary">
          Try Now
        </CtaButton>
      </nav>
      <footer>
        <CtaButton variant="primary">
          Try Now
        </CtaButton>
      </footer>
    </div>
  );
}`;
    const g = buildElementGraph(new Map([["src/Page.tsx", jsx]]));

    const ctas = g.elements.filter((e) => e.role === "CtaButton");
    expect(ctas).toHaveLength(2);
    expect(ctas.every((c) => c.kind === "component" && c.text === "Try Now")).toBe(true);
    expect(ctas.map((c) => c.landmark).sort()).toEqual(["footer", "nav"]);
    expect(ctas.every((c) => c.attributes.variant === "primary")).toBe(true);
    // Two instances of the same component name are grouped.
    expect(g.instancesByComponent.get("CtaButton")).toHaveLength(2);
  });

  it("resolves a component definition and its instantiations", () => {
    const button = `export const CtaButton = ({ children }) => <button className="cta">{children}</button>;`;
    const nav = `export function Navbar() { return <nav><CtaButton>Buy</CtaButton></nav>; }`;
    const g = buildElementGraph(new Map([["src/Cta.tsx", button], ["src/Navbar.tsx", nav]]));

    expect(g.components.get("CtaButton")?.file).toBe("src/Cta.tsx");
    expect(g.instancesByComponent.get("CtaButton")).toHaveLength(1);
  });

  it("flags list-rendered elements and dynamic text", () => {
    const jsx = `export function List({ items }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id}>{i.label}</li>
      ))}
    </ul>
  );
}`;
    const g = buildElementGraph(new Map([["src/List.tsx", jsx]]));
    const li = g.elements.find((e) => e.role === "li");
    expect(li?.inLoop).toBe(true); // one source → many runtime instances
    expect(li?.hasDynamicText).toBe(true);
    expect(li?.text).toBe("");
  });
});
