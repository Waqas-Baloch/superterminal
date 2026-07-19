import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexRepo } from "../src/core/indexer";
import { buildGraph } from "../src/core/mapper";
import { selectFiles } from "../src/core/selector";
import { loadConfig } from "../src/util/config";
import type { Selection } from "../src/core/selector";
import type { RepoGraph } from "../src/core/mapper";

// Regression: a static site where every page shares a nav bar linking to
// "#pricing". Only the home page DEFINES the pricing section — the other
// pages must not be sent in full just because their nav mentions pricing.

const NAV = '<nav><a href="index.html#pricing">Pricing</a><a href="terms.html">Terms</a><button class="subscribe">Subscribe</button></nav>';

let dir: string;
let graph: RepoGraph;
let selection: Selection;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-boiler-"));

  await fs.writeFile(
    path.join(dir, "index.html"),
    `<!doctype html><body>${NAV}
<section id="pricing" class="pricing-section">
  <h2>Pricing plans</h2>
  <div class="plan">Basic</div>
  <div class="plan">Pro</div>
</section></body>`,
  );
  await fs.writeFile(
    path.join(dir, "terms.html"),
    `<!doctype html><body>${NAV}<main><h2>Terms of service</h2><p>Legal text about the service.</p></main></body>`,
  );
  await fs.writeFile(
    path.join(dir, "imprint.html"),
    `<!doctype html><body>${NAV}<main><h2>Imprint</h2><p>Company address and contact.</p></main></body>`,
  );
  await fs.writeFile(
    path.join(dir, "styles.css"),
    `.pricing-section { padding: 2rem; }\n.plan { border: 1px solid; }\n.subscribe { background: green; }\n`,
  );

  const config = await loadConfig(dir);
  const index = await indexRepo(dir, config);
  graph = await buildGraph(dir, index);
  selection = await selectFiles({
    task: "add a buy button to the pricing section on the home page",
    root: dir,
    index,
    graph,
    budget: 30_000,
  });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("DOM symbol extraction", () => {
  it("extracts ids, classes, and headings from html", () => {
    const symbols = graph.nodes.get("index.html")!.exports;
    expect(symbols).toContain("pricing");
    expect(symbols).toContain("pricing-section");
    expect(symbols).toContain("Pricing");
  });

  it("extracts selector names from css", () => {
    const symbols = graph.nodes.get("styles.css")!.exports;
    expect(symbols).toContain("pricing-section");
    expect(symbols).toContain("subscribe");
  });
});

describe("manifest excerpting", () => {
  it("sends only task-relevant excerpts for large files", async () => {
    const { generateManifest } = await import("../src/core/manifest");
    // pad the home page so it crosses the excerpting threshold
    const filler = Array.from(
      { length: 30 },
      (_, i) => `<section id="feature-${i}" class="feature"><h3>Feature ${i}</h3><p>Text about capability ${i}.</p></section>\n`,
    ).join("\n");
    const big = (await fs.readFile(path.join(dir, "index.html"), "utf8")).replace("</body>", `${filler}</body>`);
    await fs.writeFile(path.join(dir, "index.html"), big);

    const manifest = await generateManifest({
      root: dir,
      task: "add a buy button to the pricing section on the home page",
      selection: {
        task: "add a buy button to the pricing section on the home page",
        primary: [{ path: "index.html", score: 1, tokens: 900, reasons: ["matched"] }],
        supporting: [],
        optional: [],
        totalTokens: 900,
        budget: 30_000,
        taskType: "ui",
        taskConfidence: 0.8,
        anchors: [],
      },
    });

    expect(manifest).toContain("task-relevant excerpts");
    expect(manifest).toContain('id="pricing"');
    expect(manifest).toContain("omitted)");
    expect(manifest).not.toContain("capability 15");
  });
});

describe("boilerplate contamination", () => {
  it("sends the page that defines the section in full", () => {
    expect(selection.primary.map((f) => f.path)).toContain("index.html");
  });

  it("ranks the defining page first", () => {
    expect(selection.primary[0].path).toBe("index.html");
  });

  it("does not send nav-only pages in full", () => {
    const primaryPaths = selection.primary.map((f) => f.path);
    expect(primaryPaths).not.toContain("terms.html");
    expect(primaryPaths).not.toContain("imprint.html");
  });
});
