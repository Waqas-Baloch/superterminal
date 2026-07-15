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

describe("semantic target graph — symbols (the non-UI half)", () => {
  it("extracts declarations with kind, export status, and blast radius", () => {
    const g = buildElementGraph(
      new Map([
        ["src/util.ts", "export function formatDate(d: Date) { return d.toISOString(); }\nclass Helper {}\n"],
        ["src/a.ts", 'import { formatDate } from "./util";\nexport const a = (d: Date) => formatDate(d);\n'],
        ["src/b.ts", 'import { formatDate } from "./util";\nexport const b = (d: Date) => formatDate(d);\n'],
      ]),
    );
    const fmt = g.symbols.find((s) => s.name === "formatDate" && s.file === "src/util.ts");
    expect(fmt?.kind).toBe("function");
    expect(fmt?.exported).toBe(true);
    expect(fmt?.refs).toBeGreaterThan(0); // used by a.ts and b.ts → deleting it breaks callers

    expect(g.symbols.find((s) => s.name === "Helper")?.kind).toBe("class");
    expect(g.symbols.find((s) => s.name === "a")?.exported).toBe(true);
  });

  it("finds the same name declared in two modules (a collision)", () => {
    const g = buildElementGraph(
      new Map([
        ["src/x/format.ts", "export function formatDate(d: Date) { return String(d); }"],
        ["src/y/format.ts", "export function formatDate(d: Date) { return String(d); }"],
      ]),
    );
    expect(g.symbols.filter((s) => s.name === "formatDate")).toHaveLength(2);
  });

  it("captures types and interfaces, and survives an unparseable file", () => {
    const g = buildElementGraph(
      new Map([
        ["src/t.ts", "export interface Order { id: string }\nexport type Id = string;\n"],
        ["src/broken.ts", "export function ((("],
      ]),
    );
    expect(g.symbols.find((s) => s.name === "Order")?.kind).toBe("interface");
    expect(g.symbols.find((s) => s.name === "Id")?.kind).toBe("type");
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
