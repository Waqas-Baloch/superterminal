import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadGlobalConfig, saveGlobalConfig, resolveAuth } from "../src/util/globalConfig";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "glint-home-"));
  for (const key of ["GLINT_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GLINT_HOME = home;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await fs.rm(path.join(home, "config.json"), { force: true });
});

describe("global config", () => {
  it("round-trips save and load", async () => {
    await saveGlobalConfig({ provider: "api-key", apiKey: "sk-ant-test" });
    const loaded = await loadGlobalConfig();
    expect(loaded).toEqual({ provider: "api-key", apiKey: "sk-ant-test" });
  });

  it("stores the key with owner-only permissions", async () => {
    const file = await saveGlobalConfig({ provider: "api-key", apiKey: "sk-ant-test" });
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null for missing or corrupt config", async () => {
    expect(await loadGlobalConfig()).toBeNull();
    await fs.writeFile(path.join(home, "config.json"), "not json");
    expect(await loadGlobalConfig()).toBeNull();
  });
});

describe("resolveAuth precedence", () => {
  it("returns null with no env and no stored connection", async () => {
    expect(await resolveAuth()).toBeNull();
  });

  it("uses the stored connection", async () => {
    await saveGlobalConfig({ provider: "claude-code" });
    const auth = await resolveAuth();
    expect(auth?.mode).toBe("agent-cli");
    expect(auth?.mode === "agent-cli" && auth.agent).toBe("claude-code");
  });

  it("resolves cursor and codex as agent-cli providers", async () => {
    await saveGlobalConfig({ provider: "cursor" });
    const cursor = await resolveAuth();
    expect(cursor?.mode === "agent-cli" && cursor.agent).toBe("cursor");

    await saveGlobalConfig({ provider: "codex" });
    const codex = await resolveAuth();
    expect(codex?.mode === "agent-cli" && codex.agent).toBe("codex");
  });

  it("env var beats the stored connection", async () => {
    await saveGlobalConfig({ provider: "claude-code" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const auth = await resolveAuth();
    expect(auth?.mode).toBe("api-key");
    expect(auth?.mode === "api-key" && auth.apiKey).toBe("sk-ant-env");
  });

  it("resolves a stored oauth connection", async () => {
    await saveGlobalConfig({ provider: "oauth" });
    expect((await resolveAuth())?.mode).toBe("oauth");
  });
});
