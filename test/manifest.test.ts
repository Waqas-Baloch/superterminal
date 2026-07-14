import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateManifest } from "../src/core/manifest";
import type { Selection } from "../src/core/selector";

let dir: string;
let manifest: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-manifest-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo-app", dependencies: { next: "^15.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } }),
  );
  await fs.writeFile(path.join(dir, "src", "cart.tsx"), "export function Cart() { return <div>cart</div>; }\n");
  await fs.writeFile(
    path.join(dir, "src", "orders.ts"),
    "export interface Order { id: string; total: number }\nexport async function createOrder(o: Order): Promise<void> {\n  // long body\n  return;\n}\n",
  );

  const selection: Selection = {
    task: "add checkout form",
    primary: [{ path: "src/cart.tsx", score: 1, tokens: 20, reasons: ["matched: cart"] }],
    supporting: [],
    optional: [{ path: "src/orders.ts", score: 0.4, tokens: 30, reasons: ["linked"] }],
    totalTokens: 50,
    budget: 30_000,
    taskType: "ui",
    taskConfidence: 0.8,
    anchors: [],
  };
  manifest = await generateManifest({ root: dir, task: "add checkout form", selection });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("generateManifest", () => {
  it("includes the task and project facts", () => {
    expect(manifest).toContain("## Task\nadd checkout form");
    expect(manifest).toContain("Next.js");
    expect(manifest).toContain("demo-app");
  });

  it("includes literal-intent guidance so 'remove' means delete, not rewrite", () => {
    expect(manifest).toContain("## How to apply this task");
    expect(manifest.toLowerCase()).toContain("remove");
    expect(manifest.toLowerCase()).toContain("entirely");
  });

  it("includes full content for primary files", () => {
    expect(manifest).toContain("### src/cart.tsx");
    expect(manifest).toContain("export function Cart() { return <div>cart</div>; }");
  });

  it("includes signatures, not bodies, for optional-tier files", () => {
    expect(manifest).toContain("### src/orders.ts");
    expect(manifest).toContain("export interface Order { id: string; total: number }");
    expect(manifest).toContain("export async function createOrder(o: Order): Promise<void>");
    expect(manifest).not.toContain("// long body");
  });
});

describe("generateScaffoldManifest", () => {
  it("produces a from-scratch manifest with session context", async () => {
    const { generateScaffoldManifest } = await import("../src/core/manifest");
    const scaffold = await generateScaffoldManifest({
      root: dir,
      task: "build a todo app with local storage",
      sessionNote: "Previous task in this session: set up the project",
    });
    expect(scaffold).toContain("# New project manifest");
    expect(scaffold).toContain("build a todo app with local storage");
    expect(scaffold).toContain("## Session context");
    expect(scaffold).toContain("build the project from scratch");
  });
});
