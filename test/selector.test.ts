import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexRepo } from "../src/core/indexer";
import { buildGraph } from "../src/core/mapper";
import { selectFiles } from "../src/core/selector";
import { loadConfig } from "../src/util/config";
import type { Selection } from "../src/core/selector";

let dir: string;
let selection: Selection;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-selector-"));
  await fs.mkdir(path.join(dir, "app", "cart"), { recursive: true });
  await fs.mkdir(path.join(dir, "components"), { recursive: true });
  await fs.mkdir(path.join(dir, "lib"), { recursive: true });

  await fs.writeFile(
    path.join(dir, "app", "cart", "page.tsx"),
    [
      'import { Button } from "../../components/Button";',
      "export default function CartPage() {",
      '  return <div className="cart">Cart items here <Button label="Checkout" /></div>;',
      "}",
    ].join("\n"),
  );
  // No checkout/cart vocabulary — should only arrive via the import graph
  await fs.writeFile(
    path.join(dir, "components", "Button.tsx"),
    "export function Button({ label }: { label: string }) { return <button>{label}</button>; }\n",
  );
  await fs.writeFile(
    path.join(dir, "lib", "weather.ts"),
    "export async function getForecast(city: string) { return fetch(`/w/${city}`); }\n",
  );
  await fs.writeFile(path.join(dir, "schema.prisma"), "model Order { id Int @id }\n");

  const config = await loadConfig(dir);
  const index = await indexRepo(dir, config);
  const graph = await buildGraph(dir, index);
  selection = await selectFiles({ task: "add checkout form", root: dir, index, graph, budget: 30_000 });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function allFiles(s: Selection) {
  return [...s.primary, ...s.supporting, ...s.optional].map((f) => f.path);
}

describe("selectFiles", () => {
  it("ranks the task-relevant page first", () => {
    expect(selection.primary[0].path).toBe("app/cart/page.tsx");
  });

  it("pulls in imported components via the graph", () => {
    expect(allFiles(selection)).toContain("components/Button.tsx");
  });

  it("excludes irrelevant files", () => {
    expect(allFiles(selection)).not.toContain("lib/weather.ts");
  });

  it("stays within the token budget", () => {
    expect(selection.totalTokens).toBeLessThanOrEqual(selection.budget);
  });

  it("session seeds pull in previously-edited files", async () => {
    const { indexRepo } = await import("../src/core/indexer");
    const { buildGraph } = await import("../src/core/mapper");
    const { loadConfig } = await import("../src/util/config");
    const config = await loadConfig(dir);
    const index = await indexRepo(dir, config);
    const graph = await buildGraph(dir, index);

    const seeded = await selectFiles({
      task: "add checkout form",
      root: dir,
      index,
      graph,
      budget: 30_000,
      seeds: [{ path: "lib/weather.ts", score: 0.65, reason: "follow-up: edited in previous task" }],
    });
    // Seeded files are carried-over context, not the current task's anchor —
    // they land in primary or supporting (both full-content tiers), not
    // necessarily primary specifically.
    const fullContent = [...seeded.primary, ...seeded.supporting];
    expect(fullContent.map((f) => f.path)).toContain("lib/weather.ts"); // excluded without the seed
    const weather = fullContent.find((f) => f.path === "lib/weather.ts")!;
    expect(weather.reasons[0]).toContain("previous task");
  });
});
