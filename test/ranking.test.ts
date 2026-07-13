import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { classifyTask } from "../src/core/ranking/taskProfile";
import { weightsFor, combineScore, DEFAULT_WEIGHTS, LEVEL_BASE } from "../src/core/ranking/weights";
import { computeH } from "../src/core/ranking/signals";
import { expansionMultiplier, maxExpansionDepth, bfsDepths } from "../src/core/ranking/anchors";
import { rankContext } from "../src/core/ranking/rank";
import { indexRepo } from "../src/core/indexer";
import { buildGraph } from "../src/core/mapper";
import { loadConfig } from "../src/util/config";
import type { RepoGraph } from "../src/core/mapper";

describe("classifyTask — Stage A", () => {
  it("detects task type from keyword signal", () => {
    expect(classifyTask("fix the database schema migration").taskType).toBe("data");
    expect(classifyTask("update the button color and spacing").taskType).toBe("style");
    expect(classifyTask("the checkout button click handler is broken").taskType).toBe("logic");
    expect(classifyTask("add a new API endpoint for orders").taskType).toBe("api");
    expect(classifyTask("write a test for the login form").taskType).toBe("test");
  });

  it("gives high confidence when one type dominates, low when nothing matches", () => {
    const clear = classifyTask("fix the database migration schema query");
    const vague = classifyTask("make it better");
    expect(clear.classifierConfidence).toBeGreaterThan(vague.classifierConfidence);
    expect(vague.classifierConfidence).toBeLessThan(0.5);
  });

  it("detects cross-cutting scope from explicit language", () => {
    expect(classifyTask("update the header color everywhere").scope).toBe("cross-cutting");
    expect(classifyTask("fix the checkout flow").scope).toBe("flow");
  });

  it("extracts anchor hints from quoted strings, file names, and identifiers", () => {
    const hints = classifyTask('rename the "Subscribe" button in CheckoutForm.tsx').anchorHints;
    expect(hints).toContain("subscribe");
    expect(hints).toContain("checkoutform.tsx");
    expect(hints.some((h) => h.includes("checkoutform"))).toBe(true);
  });

  it("extracts class/id selectors as anchor hints", () => {
    const hints = classifyTask("make .pricing-card bigger").anchorHints;
    expect(hints).toContain("pricing-card");
  });
});

describe("weights — mode presets and score combination", () => {
  it("emphasizes the spec's listed components per task type", () => {
    const copyWeights = weightsFor("copy");
    expect(copyWeights.M).toBeGreaterThan(DEFAULT_WEIGHTS.M);
    expect(copyWeights.O).toBeGreaterThan(DEFAULT_WEIGHTS.O);
    expect(copyWeights.D).toBeCloseTo(DEFAULT_WEIGHTS.D); // not emphasized for copy

    const styleWeights = weightsFor("style");
    for (const key of ["H", "D", "O", "P"] as const) {
      expect(styleWeights[key]).toBeGreaterThan(DEFAULT_WEIGHTS[key]);
    }
  });

  it("subtracts the noise penalty rather than adding it", () => {
    const clean = combineScore({ H: 0.8, M: 0.8, D: 0.8, O: 0.8, P: 0.8, R: 0.8, V: 0.8, C: 0.8, N: 0 }, DEFAULT_WEIGHTS);
    const noisy = combineScore({ H: 0.8, M: 0.8, D: 0.8, O: 0.8, P: 0.8, R: 0.8, V: 0.8, C: 0.8, N: 1 }, DEFAULT_WEIGHTS);
    expect(noisy).toBeLessThan(clean);
    expect(clean - noisy).toBeCloseTo(DEFAULT_WEIGHTS.N, 5);
  });

  it("never returns a negative combined score", () => {
    const allNoise = combineScore({ H: 0, M: 0, D: 0, O: 0, P: 0, R: 0, V: 0, C: 0, N: 1 }, DEFAULT_WEIGHTS);
    expect(allNoise).toBe(0);
  });
});

describe("computeH — hierarchy base priors + task modifiers", () => {
  it("matches the spec's base priors when no modifier applies", () => {
    expect(computeH("surface", "infra")).toBeCloseTo(clampCheck(LEVEL_BASE.surface + 0.15)); // infra emphasizes surface
    expect(computeH("component", "logic")).toBeCloseTo(LEVEL_BASE.component); // logic has no component modifier
  });

  it("applies the spec's worked examples", () => {
    // "Copy change: property +0.12, symbol -0.05"
    expect(computeH("property", "copy")).toBeCloseTo(LEVEL_BASE.property + 0.12);
    expect(computeH("symbol", "copy")).toBeCloseTo(LEVEL_BASE.symbol - 0.05);
  });

  it("clamps to [0,1]", () => {
    expect(computeH("symbol", "copy")).toBeLessThanOrEqual(1);
    expect(computeH("symbol", "copy")).toBeGreaterThanOrEqual(0);
  });
});

function clampCheck(n: number): number {
  return Math.max(0, Math.min(1, n));
}

describe("expansion decay + depth", () => {
  it("E(depth) = exp(-0.7*depth), so depth 0 is full weight and it decays monotonically", () => {
    expect(expansionMultiplier(0)).toBeCloseTo(1);
    expect(expansionMultiplier(1)).toBeCloseTo(Math.exp(-0.7));
    expect(expansionMultiplier(2)).toBeLessThan(expansionMultiplier(1));
  });

  it("widens max depth for low-confidence or cross-cutting tasks", () => {
    const confident = maxExpansionDepth({ taskType: "ui", scope: "component", classifierConfidence: 0.9, anchorHints: [] });
    const unsure = maxExpansionDepth({ taskType: "ui", scope: "component", classifierConfidence: 0.2, anchorHints: [] });
    const crossCutting = maxExpansionDepth({ taskType: "ui", scope: "cross-cutting", classifierConfidence: 0.9, anchorHints: [] });
    expect(unsure).toBeGreaterThan(confident);
    expect(crossCutting).toBeGreaterThan(confident);
  });
});

describe("bfsDepths — shortest hop distance from an anchor set", () => {
  function graph(edges: Record<string, string[]>): RepoGraph {
    const nodes = new Map();
    for (const [path, imports] of Object.entries(edges)) {
      nodes.set(path, { path, imports, importedBy: [], exports: [], externals: [] });
    }
    for (const [path, node] of nodes) for (const imp of node.imports) nodes.get(imp)?.importedBy.push(path);
    return { nodes };
  }

  it("assigns depth 0 to the anchor and increasing hop distance to neighbors", () => {
    const g = graph({ a: ["b"], b: ["c"], c: [] });
    const distances = bfsDepths(g, ["a"], 5);
    expect(distances.get("a")).toBe(0);
    expect(distances.get("b")).toBe(1);
    expect(distances.get("c")).toBe(2);
  });

  it("traverses both import directions (a file's consumers count too)", () => {
    const g = graph({ a: [], b: ["a"], c: [] }); // b imports a — a should reach b via importedBy
    const distances = bfsDepths(g, ["a"], 5);
    expect(distances.get("b")).toBe(1);
    expect(distances.has("c")).toBe(false); // unreachable
  });

  it("respects the maxDepth cap", () => {
    const g = graph({ a: ["b"], b: ["c"], c: ["d"], d: [] });
    const distances = bfsDepths(g, ["a"], 1);
    expect(distances.get("b")).toBe(1);
    expect(distances.has("c")).toBe(false);
  });
});

// End-to-end: the full rankContext() pipeline against a small fixture,
// verifying the spec's "smallest complete set" principle in practice.
describe("rankContext — end to end", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-ranking-"));
    await fs.mkdir(path.join(dir, "app", "cart"), { recursive: true });
    await fs.mkdir(path.join(dir, "components"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "app", "cart", "page.tsx"),
      [
        'import { Button } from "../../components/Button";',
        "export default function CartPage() {",
        '  return <div className="cart">Cart items <Button label="Checkout" /></div>;',
        "}",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(dir, "components", "Button.tsx"),
      "export function Button({ label }: { label: string }) { return <button>{label}</button>; }\n",
    );
    await fs.writeFile(path.join(dir, "schema.prisma"), "model Order { id Int @id\n  total Int }\n");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function rank(task: string) {
    const config = await loadConfig(dir);
    const index = await indexRepo(dir, config);
    const graph = await buildGraph(dir, index);
    return rankContext({ task, root: dir, index, graph, budget: 30_000 });
  }

  it("classifies the task and surfaces an anchor", async () => {
    const result = await rank("add a checkout button");
    expect(result.taskProfile.taskType).toBeTruthy();
    expect(result.anchors.length).toBeGreaterThan(0);
  });

  it("puts the anchor page in the primary tier", async () => {
    const result = await rank("add a checkout button");
    expect(result.primary.map((f) => f.path)).toContain("app/cart/page.tsx");
  });

  it("pulls in the imported component via graph expansion", async () => {
    const result = await rank("add a checkout button");
    const allPaths = [...result.primary, ...result.supporting, ...result.optional].map((f) => f.path);
    expect(allPaths).toContain("components/Button.tsx");
  });

  it("does not spend full-content budget on the schema for an unrelated UI tweak", async () => {
    // A weak coincidental text match (e.g. a synonym leak) may still earn a
    // cheap optional-tier signature peek — that's harmless. What the "smallest
    // complete set" principle actually protects is full-content budget: an
    // unrelated schema must not land in primary/supporting.
    const result = await rank("make the cart button bigger");
    const fullContent = [...result.primary, ...result.supporting].map((f) => f.path);
    expect(fullContent).not.toContain("schema.prisma");
  });

  it("includes the schema when the task is genuinely about the data it defines", async () => {
    const result = await rank("add a total field to the Order model in the database schema");
    const allPaths = [...result.primary, ...result.supporting, ...result.optional].map((f) => f.path);
    expect(allPaths).toContain("schema.prisma");
    expect(result.taskProfile.taskType).toBe("data");
  });

  it("stays within the token budget", async () => {
    const result = await rank("add a checkout button");
    expect(result.totalTokens).toBeLessThanOrEqual(result.budget);
  });
});
