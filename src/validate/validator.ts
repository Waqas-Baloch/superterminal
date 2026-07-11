import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { execa } from "execa";

export interface ValidationResult {
  name: string;
  ok: boolean;
  output: string;
}

const TAIL_CHARS = 4000;
const TIMEOUT_MS = 180_000;

/** Run every validator the target repo actually has configured. Never assumes. */
export async function runValidators(root: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const pkg = await readJson(nodePath.join(root, "package.json"));

  if ((await exists(nodePath.join(root, "tsconfig.json"))) && (await localBin(root, "tsc"))) {
    results.push(await run("tsc", nodePath.join(root, "node_modules", ".bin", "tsc"), ["--noEmit"], root));
  }

  if ((await hasEslintConfig(root, pkg)) && (await localBin(root, "eslint"))) {
    results.push(await run("eslint", nodePath.join(root, "node_modules", ".bin", "eslint"), ["."], root));
  }

  const testScript: string | undefined = pkg?.scripts?.test;
  if (testScript && !testScript.includes("no test specified")) {
    results.push(await run("test", "npm", ["test", "--silent"], root));
  }

  return results;
}

async function run(name: string, cmd: string, args: string[], cwd: string): Promise<ValidationResult> {
  const result = await execa(cmd, args, {
    cwd,
    reject: false,
    all: true,
    timeout: TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const output = (result.all ?? "").toString();
  return {
    name,
    ok: result.exitCode === 0,
    output: output.length > TAIL_CHARS ? output.slice(-TAIL_CHARS) : output,
  };
}

async function hasEslintConfig(root: string, pkg: any): Promise<boolean> {
  if (pkg?.eslintConfig) return true;
  const candidates = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yml",
    ".eslintrc.yaml",
  ];
  for (const c of candidates) {
    if (await exists(nodePath.join(root, c))) return true;
  }
  return false;
}

async function localBin(root: string, name: string): Promise<boolean> {
  return exists(nodePath.join(root, "node_modules", ".bin", name));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
