import { describe, it, expect } from "vitest";
import { buildIntentFrame, detectAmbiguity, classifyBand, type Band } from "../src/core/understanding";
import type { Selection } from "../src/core/selector";

// ─────────────────────────────────────────────────────────────────────────────
// Glint understanding — evaluation harness.
//
// This is how ">99% accuracy" becomes a measured number instead of a claim. It
// runs a labeled library of ambiguous coding tasks (seeded with every real bug
// that has burned us) through the understanding engine and measures band
// accuracy plus the safety-critical rates from the spec: over-ask, under-ask,
// and destructive-miss. The destructive-miss rate MUST be 0 — that's the
// precision-via-abstention guarantee (never silently make a broad destructive
// edit). Add a failing case here first, then fix the engine.
// ─────────────────────────────────────────────────────────────────────────────

interface EvalCase {
  name: string;
  files: Record<string, string>;
  request: string;
  band: Band; // gold band
  targets?: string[]; // gold target landmarks and/or files the edit should resolve to
  excludes?: string[]; // locations/files that must NOT be offered (e.g. other pages)
}

const html = (body: string) => `<!doctype html><html><body>\n${body}\n</body></html>`;

const CASES: EvalCase[] = [
  {
    name: "HTML nav+footer identical buttons, destructive (the original bug)",
    files: {
      "index.html": html(
        '  <nav><button class="cta">Try Now</button></nav>\n  <footer><button class="cta">Try Now</button></footer>',
      ),
    },
    request: "remove the Try Now button",
    band: "red",
    targets: ["nav", "footer"],
  },
  {
    name: "multi-line React component instances, same file, destructive",
    files: {
      "src/Page.tsx": `export function Page() {
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
}`,
    },
    request: "remove the Try Now button",
    band: "red",
    targets: ["nav", "footer"],
  },
  {
    name: "same copy across two component files, destructive",
    files: {
      "src/Header.tsx": `export const Header = () => (\n  <header>\n    <CtaButton>Get Started</CtaButton>\n  </header>\n);`,
      "src/Footer.tsx": `export const Footer = () => (\n  <footer>\n    <CtaButton>Get Started</CtaButton>\n  </footer>\n);`,
    },
    request: "delete Get Started",
    band: "red",
    targets: ["src/Header.tsx", "src/Footer.tsx"],
  },
  {
    name: "list-rendered element, destructive (blast radius)",
    files: {
      "src/List.tsx": `export function Grid({ products }) {
  return (
    <section>
      {products.map((p) => (
        <ProductCard key={p.id} title={p.title} />
      ))}
    </section>
  );
}`,
    },
    request: "remove the product card",
    band: "red",
  },
  {
    name: "shared component reused 3x, destructive",
    files: {
      "src/App.tsx": `export function App() {
  return (
    <>
      <header><PrimaryButton>Sign up</PrimaryButton></header>
      <main><PrimaryButton>Sign up</PrimaryButton></main>
      <footer><PrimaryButton>Sign up</PrimaryButton></footer>
    </>
  );
}`,
    },
    request: "remove Sign up",
    band: "red",
  },
  {
    name: "task scoped to a named page — ignore the same copy on other pages",
    files: {
      "index.html": html(
        '  <header><button>Try Now</button></header>\n  <footer id="support"><button>Try Now</button></footer>',
      ),
      "refund.html": html("  <header><button>Try Now</button></header>"),
      "terms.html": html("  <header><button>Try Now</button></header>"),
    },
    request: "remove Try Now from index page",
    band: "red",
    targets: ["index.html"],
    excludes: ["refund.html", "terms.html"],
  },
  {
    name: "duplicate copy, non-destructive rename → ask, don't block",
    files: {
      "index.html": html('  <nav><button>Try Now</button></nav>\n  <footer><button>Try Now</button></footer>'),
    },
    request: "rename Try Now to Start",
    band: "orange",
    targets: ["nav", "footer"],
  },
  {
    name: "duplicate component, restyle → ask which",
    files: {
      "src/App.tsx": `export function App() {
  return (
    <>
      <header><PrimaryButton>Subscribe</PrimaryButton></header>
      <aside><PrimaryButton>Subscribe</PrimaryButton></aside>
    </>
  );
}`,
    },
    request: "restyle the Subscribe button",
    band: "orange",
  },
  {
    name: "single clear target, vague styling → infer style (yellow)",
    files: {
      "index.html": html('  <section id="hero"><h1>Welcome</h1><p>Build faster</p></section>'),
    },
    request: "make the hero nicer",
    band: "yellow",
  },
  {
    name: "unique destructive target → execute (green, over-ask guard)",
    files: {
      "index.html": html(
        '  <nav><button>Subscribe</button></nav>\n  <main><button>Buy now</button></main>\n  <footer><button>Contact us</button></footer>',
      ),
    },
    request: "remove the Subscribe button",
    band: "green",
  },
  {
    name: "distinct near-duplicate copy, destructive → execute (over-ask guard)",
    files: {
      "index.html": html('  <nav><button>Sign in</button></nav>\n  <header><button>Sign up</button></header>'),
    },
    request: "remove the Sign up button",
    band: "green",
  },
  {
    name: "well-specified restyle with concrete value → execute (green)",
    files: {
      "index.html": html('  <button class="buy">Buy</button>\n  <button class="sell">Sell</button>'),
    },
    request: "change the buy button to red",
    band: "green",
  },
  {
    name: "additive task, no existing target → execute (green)",
    files: { "index.html": html("  <main><h1>Home</h1></main>") },
    request: "add a newsletter signup form",
    band: "green",
  },
];

function selectionFor(files: string[]): Selection {
  // These cases isolate the understanding layer; assume the ranking resolved a
  // single confident file (the duplicate/list branches fire before this matters).
  return {
    task: "",
    primary: [{ path: files[0], score: 1, tokens: 10, reasons: ["m"] }],
    supporting: [],
    optional: [],
    totalTokens: 10,
    budget: 30_000,
    taskType: "ui",
    taskConfidence: 0.9,
    anchors: [{ path: files[0], score: 0.9 }],
  };
}

function run(c: EvalCase) {
  const contents = new Map(Object.entries(c.files));
  const frame = buildIntentFrame(c.request);
  const ambiguity = detectAmbiguity(c.request, frame, contents);
  const { band, reason } = classifyBand(frame, selectionFor(Object.keys(c.files)), ambiguity);

  const detected = new Set<string>();
  for (const i of ambiguity.duplicate?.instances ?? []) {
    if (i.landmark) detected.add(i.landmark);
    detected.add(i.file);
  }
  if (ambiguity.listTarget) detected.add(ambiguity.listTarget.instance.file);
  return { band, reason, detected };
}

const ASK = new Set<Band>(["orange", "red"]);
const EXEC = new Set<Band>(["green", "yellow"]);

describe("understanding evaluation harness", () => {
  const results = CASES.map((c) => ({ c, ...run(c) }));

  let exact = 0;
  let overAsk = 0;
  let underAsk = 0;
  let destructiveMiss = 0;
  const failures: string[] = [];

  for (const { c, band, detected } of results) {
    if (band === c.band) exact++;
    else failures.push(`${c.name}: expected ${c.band}, got ${band}`);
    if (EXEC.has(c.band) && ASK.has(band)) overAsk++;
    if (ASK.has(c.band) && EXEC.has(band)) underAsk++;
    if (c.band === "red" && EXEC.has(band)) destructiveMiss++;
    // Target resolution: every gold target must be among the resolved locations.
    if (c.targets) {
      for (const t of c.targets) {
        const hit = [...detected].some((d) => d === t || d.endsWith(`/${t}`) || d === t.split("/").pop());
        if (!hit) failures.push(`${c.name}: missing target "${t}" (resolved: ${[...detected].join(", ") || "none"})`);
      }
    }
    if (c.excludes) {
      for (const x of c.excludes) {
        const hit = [...detected].some((d) => d === x || d.endsWith(`/${x}`) || d === x.split("/").pop());
        if (hit) failures.push(`${c.name}: should NOT offer "${x}" (resolved: ${[...detected].join(", ")})`);
      }
    }
  }

  const n = CASES.length;
  const bandAccuracy = exact / n;

  it("reports metrics", () => {
    /* eslint-disable no-console */
    console.log("\n── Glint understanding — eval metrics ──");
    console.log(`cases:            ${n}`);
    console.log(`band accuracy:    ${(bandAccuracy * 100).toFixed(1)}%  (${exact}/${n})`);
    console.log(`over-ask rate:    ${((overAsk / n) * 100).toFixed(1)}%`);
    console.log(`under-ask rate:   ${((underAsk / n) * 100).toFixed(1)}%`);
    console.log(`destructive-miss: ${destructiveMiss}  (must be 0)`);
    if (failures.length) console.log("failures:\n  " + failures.join("\n  "));
    console.log("────────────────────────────────────────\n");
    expect(true).toBe(true);
  });

  it("never silently makes a broad destructive edit (destructive-miss = 0)", () => {
    expect(destructiveMiss).toBe(0);
  });

  it("resolves every case to the correct band and targets", () => {
    expect(failures).toEqual([]);
  });

  it("keeps over-asking and under-asking low", () => {
    expect(overAsk / n).toBeLessThanOrEqual(0.1);
    expect(underAsk / n).toBeLessThanOrEqual(0.1);
  });
});
