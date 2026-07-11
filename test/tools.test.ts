import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EditStage } from "../src/claude/tools";

let dir: string;
let stage: EditStage;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-stage-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "const x = 1;\nconst y = 2;\nconst z = 1;\n");
  stage = new EditStage(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("EditStage safety", () => {
  it("rejects path traversal", async () => {
    await expect(stage.read("../outside.txt")).rejects.toThrow(/escapes/);
  });

  it("rejects blocked segments and lockfiles", async () => {
    await expect(stage.read(".git/config")).rejects.toThrow(/not editable/);
    await expect(stage.write("node_modules/x.js", "")).rejects.toThrow(/not editable/);
    await expect(stage.write("package-lock.json", "{}")).rejects.toThrow(/not editable/);
  });
});

describe("EditStage str_replace", () => {
  it("rejects snippets that do not match", async () => {
    await expect(stage.strReplace("src/a.ts", "nope", "x")).rejects.toThrow(/not found/);
  });

  it("rejects ambiguous snippets", async () => {
    await expect(stage.strReplace("src/a.ts", "= 1;", "= 9;")).rejects.toThrow(/2 times/);
  });

  it("stages a unique replacement without touching disk", async () => {
    await stage.strReplace("src/a.ts", "const y = 2;", "const y = 20;");
    expect(await stage.read("src/a.ts")).toContain("const y = 20;");
    expect(await fs.readFile(path.join(dir, "src", "a.ts"), "utf8")).toContain("const y = 2;");
  });
});

describe("EditStage apply", () => {
  it("backs up modified files and records created files", async () => {
    await stage.strReplace("src/a.ts", "const y = 2;", "const y = 20;");
    await stage.write("src/new.ts", "export const fresh = true;\n");
    const { modified, created } = await stage.apply("run-1");

    expect(modified).toEqual(["src/a.ts"]);
    expect(created).toEqual(["src/new.ts"]);

    // disk updated
    expect(await fs.readFile(path.join(dir, "src", "a.ts"), "utf8")).toContain("const y = 20;");
    expect(await fs.readFile(path.join(dir, "src", "new.ts"), "utf8")).toContain("fresh");

    // backup holds the original; created.json lists the new file
    const backup = await fs.readFile(path.join(dir, ".glint", "backup", "run-1", "files", "src", "a.ts"), "utf8");
    expect(backup).toContain("const y = 2;");
    const createdJson = JSON.parse(
      await fs.readFile(path.join(dir, ".glint", "backup", "run-1", "created.json"), "utf8"),
    );
    expect(createdJson).toEqual(["src/new.ts"]);
  });

  it("keeps the first backup across repeated applies", async () => {
    await stage.strReplace("src/a.ts", "const y = 2;", "const y = 20;");
    await stage.apply("run-2");
    await stage.strReplace("src/a.ts", "const y = 20;", "const y = 200;");
    await stage.apply("run-2");

    const backup = await fs.readFile(path.join(dir, ".glint", "backup", "run-2", "files", "src", "a.ts"), "utf8");
    expect(backup).toContain("const y = 2;"); // original, not the intermediate state
    expect(stage.allTouched).toEqual(["src/a.ts"]);
  });
});
