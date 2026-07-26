import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  setLinear,
  setJira,
  getLinear,
  getJira,
  clearTracker,
  connectedTrackers,
  normalizeJiraSite,
} from "../src/util/credentials";
import { usableTrackers } from "../src/trackers";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "st-cred-"));
  process.env.SUPER_T_HOME = home;
});
afterEach(async () => {
  delete process.env.SUPER_T_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("credential store — protocol T3 as code", () => {
  it("round-trips and reports connected trackers by name only", async () => {
    expect(await connectedTrackers()).toEqual([]);
    await setLinear({ apiKey: "lin_api_test123456" });
    await setJira({ site: "https://acme.atlassian.net", email: "dev@acme.com", apiToken: "tok" });
    expect(await connectedTrackers()).toEqual(["linear", "jira"]);
    expect((await getLinear())?.apiKey).toBe("lin_api_test123456");
    expect((await getJira())?.site).toBe("https://acme.atlassian.net");
  });

  it("stores in the HOME dir with 0600 — never in a repo", async () => {
    await setLinear({ apiKey: "k" });
    const file = path.join(home, "credentials.json");
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps 0600 even when the file already existed with looser permissions", async () => {
    const file = path.join(home, "credentials.json");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(file, "{}", { mode: 0o644 });
    await setLinear({ apiKey: "k" });
    expect(((await fs.stat(file)).mode & 0o777)).toBe(0o600);
  });

  it("disconnect removes exactly one tracker", async () => {
    await setLinear({ apiKey: "a" });
    await setJira({ site: "https://x.atlassian.net", email: "e@x.com", apiToken: "t" });
    await clearTracker("linear");
    expect(await connectedTrackers()).toEqual(["jira"]);
  });
});

describe("normalizeJiraSite — a bare https origin or nothing", () => {
  it("accepts and normalizes plain hosts", () => {
    expect(normalizeJiraSite("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(normalizeJiraSite("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
  });

  it("rejects paths, queries, credentials, and http", () => {
    expect(normalizeJiraSite("https://acme.atlassian.net/evil/path")).toBeNull();
    expect(normalizeJiraSite("https://acme.atlassian.net?x=1")).toBeNull();
    expect(normalizeJiraSite("https://user:pass@acme.atlassian.net")).toBeNull();
    expect(normalizeJiraSite("http://acme.atlassian.net")).toBeNull();
    expect(normalizeJiraSite("")).toBeNull();
  });
});

describe("usableTrackers — every usable tracker, not just the first", () => {
  it("explains every unusable tracker when nothing is configured", async () => {
    const r = await usableTrackers(home); // home dir: not a github repo, no tokens
    expect(r.usable).toEqual([]);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
    expect(r.reasons.join("\n")).toContain("tracker connect");
  });

  it("a preference narrows to that tracker only", async () => {
    const r = await usableTrackers(home, "linear");
    expect(r.usable).toEqual([]);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain("Linear");
  });

  it("returns a connected tracker as usable", async () => {
    await setLinear({ apiKey: "k" });
    const r = await usableTrackers(home, "linear");
    expect(r.usable.map((a) => a.id)).toEqual(["linear"]);
  });

  it("lists ALL usable trackers together, so no connected work is hidden", async () => {
    await setLinear({ apiKey: "k" });
    await setJira({ site: "https://acme.atlassian.net", email: "e@acme.com", apiToken: "t" });
    const r = await usableTrackers(home);
    // Both token-based trackers qualify; GitHub can't (this dir is no repo).
    expect(r.usable.map((a) => a.id).sort()).toEqual(["jira", "linear"]);
    expect(r.reasons.join(" ")).toContain("GitHub");
  });
});

describe("tracker use — pinning a project's tracker", () => {
  let dir: string;
  let cwd: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-pin-"));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const readConfig = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(path.join(dir, ".super-t", "config.json"), "utf8"));

  it("writes the pin, creating the state dir", async () => {
    const { trackerCommand } = await import("../src/commands/tracker");
    await trackerCommand("use", "linear");
    expect((await readConfig()).tracker).toBe("linear");
  });

  it("preserves every other setting in the config", async () => {
    await fs.mkdir(path.join(dir, ".super-t"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".super-t", "config.json"),
      JSON.stringify({ mode: "safe", reviewer: "codex", budgetTokens: 12345 }),
    );
    const { trackerCommand } = await import("../src/commands/tracker");
    await trackerCommand("use", "jira");
    const c = await readConfig();
    expect(c).toMatchObject({ mode: "safe", reviewer: "codex", budgetTokens: 12345, tracker: "jira" });
  });

  it("`auto` clears the pin without touching other settings", async () => {
    const { trackerCommand } = await import("../src/commands/tracker");
    await trackerCommand("use", "linear");
    await trackerCommand("use", "auto");
    expect(await readConfig()).not.toHaveProperty("tracker");
  });

  it("refuses to overwrite a malformed config — other settings must survive", async () => {
    await fs.mkdir(path.join(dir, ".super-t"), { recursive: true });
    const broken = '{ "mode": "safe", oops';
    await fs.writeFile(path.join(dir, ".super-t", "config.json"), broken);
    const { trackerCommand } = await import("../src/commands/tracker");
    await trackerCommand("use", "linear");
    expect(await fs.readFile(path.join(dir, ".super-t", "config.json"), "utf8")).toBe(broken);
  });

  it("rejects an unknown tracker name", async () => {
    const { trackerCommand } = await import("../src/commands/tracker");
    await trackerCommand("use", "notion");
    await expect(fs.access(path.join(dir, ".super-t", "config.json"))).rejects.toThrow();
  });
});

describe("adapter scope — wording must match where assignment lives", () => {
  it("GitHub is per-repository; Linear and Jira are workspace-wide", async () => {
    const { TRACKERS } = await import("../src/trackers");
    const byId = Object.fromEntries(TRACKERS.map((t) => [t.id, t.scope]));
    expect(byId).toEqual({ github: "repository", linear: "workspace", jira: "workspace" });
  });
});

describe("global config permissions — it can hold an API key", () => {
  it("is forced to 0600 even when the file already existed with looser permissions", async () => {
    const { saveGlobalConfig } = await import("../src/util/globalConfig");
    const file = path.join(home, "config.json");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ provider: "codex" }), { mode: 0o644 });
    await saveGlobalConfig({ provider: "codex", reviewer: "claude-code" });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
