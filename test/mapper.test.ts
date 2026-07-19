import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexRepo } from "../src/core/indexer";
import { buildGraph } from "../src/core/mapper";
import { loadConfig } from "../src/util/config";
import type { RepoGraph } from "../src/core/mapper";

let dir: string;
let graph: RepoGraph;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-mapper-"));
  await fs.mkdir(path.join(dir, "src", "lib"), { recursive: true });

  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  );
  await fs.writeFile(
    path.join(dir, "src", "a.ts"),
    [
      'import { b } from "./b";',
      'import helper from "@/lib/helper";',
      'import fs from "node:fs";',
      'import React from "react";',
      "export const a = b + 1;",
      "export function useThing() { return helper(); }",
    ].join("\n"),
  );
  await fs.writeFile(path.join(dir, "src", "b.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(dir, "src", "lib", "helper.ts"), "export default function helper() { return 0; }\n");

  const config = await loadConfig(dir);
  const index = await indexRepo(dir, config);
  graph = await buildGraph(dir, index);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("buildGraph", () => {
  it("resolves relative imports", () => {
    expect(graph.nodes.get("src/a.ts")!.imports).toContain("src/b.ts");
  });

  it("resolves tsconfig path aliases", () => {
    expect(graph.nodes.get("src/a.ts")!.imports).toContain("src/lib/helper.ts");
  });

  it("records reverse edges", () => {
    expect(graph.nodes.get("src/b.ts")!.importedBy).toContain("src/a.ts");
    expect(graph.nodes.get("src/lib/helper.ts")!.importedBy).toContain("src/a.ts");
  });

  it("records external packages, not repo files", () => {
    const a = graph.nodes.get("src/a.ts")!;
    expect(a.externals).toContain("node:fs");
    expect(a.externals).toContain("react");
    expect(a.imports).not.toContain("react");
  });

  it("extracts exported symbol names", () => {
    expect(graph.nodes.get("src/a.ts")!.exports.sort()).toEqual(["a", "useThing"]);
  });
});
