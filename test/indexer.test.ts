import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexRepo } from "../src/core/indexer";
import { loadConfig } from "../src/util/config";
import { STATE_DIR } from "../src/util/paths";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-test-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "app.tsx"), "export const App = () => null;\n");
  await fs.writeFile(path.join(dir, "index.html"), "<h1>hi</h1>\n");
  await fs.writeFile(path.join(dir, "package.json"), "{}\n");
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await fs.writeFile(path.join(dir, "secret.ts"), "export const s = 1;\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "secret.ts\n");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("indexRepo", () => {
  it("indexes code files, skips node_modules and gitignored files", async () => {
    const config = await loadConfig(dir);
    const index = await indexRepo(dir, config);
    const paths = index.files.map((f) => f.path);

    expect(paths).toContain("src/app.tsx");
    expect(paths).toContain("index.html");
    expect(paths).toContain("package.json");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths).not.toContain("secret.ts");
  });

  it("records size, lines, and hash per file", async () => {
    const config = await loadConfig(dir);
    const index = await indexRepo(dir, config);
    const app = index.files.find((f) => f.path === "src/app.tsx");

    expect(app).toBeDefined();
    expect(app!.size).toBeGreaterThan(0);
    expect(app!.lines).toBe(2);
    expect(app!.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it(`writes the index cache to ${STATE_DIR}/index.json`, async () => {
    const cached = JSON.parse(await fs.readFile(path.join(dir, STATE_DIR, "index.json"), "utf8"));
    expect(cached.files.length).toBeGreaterThan(0);
  });
});
