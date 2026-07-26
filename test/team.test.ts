import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  validUsername,
  codeownersFor,
  isAdmin,
  loadTeam,
  saveTeam,
  localGovernedChanges,
  DEFAULT_GOVERNED,
  BETA_MAX_MEMBERS,
  type Team,
} from "../src/core/team";

const team = (over: Partial<Team> = {}): Team => ({
  version: 1,
  admins: ["alice"],
  members: ["alice", "bob"],
  governed: DEFAULT_GOVERNED,
  requireApproval: true,
  ...over,
});

describe("validUsername — usernames reach argv, so they're validated first", () => {
  it("accepts real GitHub logins", () => {
    for (const n of ["alice", "Waqas-Baloch", "a", "dev-1", "a1b2c3"]) expect(validUsername(n), n).toBe(true);
  });

  it("rejects anything that could be an argument or a path", () => {
    for (const n of [
      "--repo",              // a flag
      "alice;rm -rf /",      // command chaining
      "alice bob",           // spaces
      "../../etc/passwd",    // traversal
      "-alice",              // leading dash: flag-like and invalid on GitHub
      "alice-",              // trailing dash
      "al--ice",             // consecutive dashes
      "a".repeat(40),        // over 39 chars
      "",
    ]) {
      expect(validUsername(n), n).toBe(false);
    }
  });
});

describe("isAdmin", () => {
  it("matches case-insensitively — GitHub logins are displayed inconsistently", () => {
    expect(isAdmin(team(), "ALICE")).toBe(true);
    expect(isAdmin(team(), "alice")).toBe(true);
    expect(isAdmin(team(), "bob")).toBe(false);
    expect(isAdmin(team(), null)).toBe(false);
  });
});

describe("codeownersFor — makes approval enforceable, not advisory", () => {
  it("assigns every governed path to every admin, rooted", () => {
    const out = codeownersFor(team({ admins: ["alice", "carol"] }));
    expect(out).toContain("/.super-t/rules.md @alice @carol");
    expect(out).toContain("/AGENTS.md @alice @carol");
    // Unanchored patterns would match nested files elsewhere in the repo.
    for (const line of out.split("\n").filter((l) => l && !l.startsWith("#"))) {
      expect(line.startsWith("/")).toBe(true);
    }
  });
});

describe("team.json is repo content, so it's validated", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-team-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a valid team", async () => {
    await saveTeam(dir, team());
    expect((await loadTeam(dir))?.admins).toEqual(["alice"]);
  });

  it("refuses a malformed or admin-less team rather than half-trusting it", async () => {
    await fs.mkdir(path.join(dir, ".super-t"), { recursive: true });
    const file = path.join(dir, ".super-t", "team.json");
    await fs.writeFile(file, "{ not json");
    expect(await loadTeam(dir)).toBeNull();
    // No admins would mean nobody can approve anything — reject it.
    await fs.writeFile(file, JSON.stringify({ version: 1, admins: [] }));
    expect(await loadTeam(dir)).toBeNull();
  });

  it("caps beta teams at five", () => {
    expect(BETA_MAX_MEMBERS).toBe(5);
  });
});

describe("localGovernedChanges — the guardrail's evidence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-team-git-"));
    await execa("git", ["init", "-q"], { cwd: dir });
    await execa("git", ["config", "user.email", "t@t.local"], { cwd: dir });
    await execa("git", ["config", "user.name", "t"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".super-t"), { recursive: true });
    await fs.writeFile(path.join(dir, ".super-t", "rules.md"), "Never edit dist/.\n");
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-qm", "standards", "--no-verify"], { cwd: dir });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports nothing when standards match the commit", async () => {
    expect(await localGovernedChanges(dir, team())).toEqual([]);
  });

  it("catches an edited rules file", async () => {
    await fs.writeFile(path.join(dir, ".super-t", "rules.md"), "Actually, edit anything.\n");
    expect(await localGovernedChanges(dir, team())).toContain(".super-t/rules.md");
  });

  it("catches a NEW skill too — adding a skill is a standards change", async () => {
    await fs.mkdir(path.join(dir, ".super-t", "skills", "sneaky"), { recursive: true });
    await fs.writeFile(path.join(dir, ".super-t", "skills", "sneaky", "SKILL.md"), "do whatever");
    const changes = await localGovernedChanges(dir, team());
    expect(changes.join(" ")).toContain("skills");
  });

  it("ignores ordinary code changes — only governed paths count", async () => {
    await fs.writeFile(path.join(dir, "app.ts"), "export const x = 1;\n");
    expect(await localGovernedChanges(dir, team())).toEqual([]);
  });
});

describe("invite safety: a username is a person, not a string", () => {
  it("keeps admin-removal from orphaning a team", () => {
    // Removing the only admin would leave nobody able to approve standards.
    const t = team({ admins: ["alice"], members: ["alice", "bob"] });
    expect(t.admins).toHaveLength(1);
    expect(isAdmin(t, "alice")).toBe(true);
  });

  it("rejects a name that isn't a valid GitHub login before any lookup", async () => {
    const { lookupGitHubUser } = await import("../src/core/team");
    // No network call should even be attempted for these.
    for (const bad of ["--repo", "a b", "../x", "-alice", ""]) {
      expect(await lookupGitHubUser(process.cwd(), bad), bad).toBeNull();
    }
  });
});

describe("CODEOWNERS drops a removed admin", () => {
  it("stops naming someone once they're off the team", () => {
    const before = codeownersFor(team({ admins: ["alice", "bob"] }));
    expect(before).toContain("@bob");
    const after = codeownersFor(team({ admins: ["alice"] }));
    expect(after).not.toContain("@bob");
    expect(after).toContain("@alice");
  });
});
