import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isLimitError, applyMode, AgentLimitError, AGENT_CLIS } from "../src/claude/agentCli";
import { recordLimit, lastLimit, inCooldown, agoLabel } from "../src/util/limits";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "st-limits-"));
  process.env.SUPER_T_HOME = home;
});
afterEach(async () => {
  delete process.env.SUPER_T_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("isLimitError — fail over on 'not now', never on 'this is broken'", () => {
  it("recognizes the vendors' limit refusals", () => {
    for (const msg of [
      "You've reached your usage limit. Your limit resets at 7pm.",
      "Rate limit exceeded, please try again later",
      "insufficient_quota: You exceeded your current quota",
      "HTTP 429 Too Many Requests",
      "Weekly limit reached — upgrade to continue",
      "you are out of credits",
    ]) {
      expect(isLimitError(msg), msg).toBe(true);
    }
  });

  it("does NOT classify real failures as limits — retrying a bug on a second vendor just spends their quota too", () => {
    for (const msg of [
      "SyntaxError: Unexpected token in config.json",
      "command not found: rg",
      "exited with code 1 (see its output above)",
      "ENOENT: no such file or directory",
      "model produced invalid output",
    ]) {
      expect(isLimitError(msg), msg).toBe(false);
    }
  });

  it("carries the failing agent's id on the typed error", () => {
    const e = new AgentLimitError("codex", "quota exceeded");
    expect(e.agentId).toBe("codex");
    expect(e.message).toContain("codex");
  });
});

describe("limit ledger — the honest alternative to a fake fuel gauge", () => {
  it("records and reads a limit hit", async () => {
    expect(await lastLimit("codex")).toBeNull();
    await recordLimit("codex");
    expect(await lastLimit("codex")).toBeTruthy();
  });

  it("puts a just-limited agent in cooldown, and lets it out later", async () => {
    await recordLimit("claude-code");
    expect(await inCooldown("claude-code")).toBe(true);
    // 31 minutes later the cooldown has expired
    expect(await inCooldown("claude-code", Date.now() + 31 * 60 * 1000)).toBe(false);
    expect(await inCooldown("codex")).toBe(false); // untouched agent is available
  });

  it("labels the age readably for doctor", () => {
    const now = Date.now();
    expect(agoLabel(new Date(now - 5 * 60000).toISOString(), now)).toBe("5m ago");
    expect(agoLabel(new Date(now - 3 * 3600000).toISOString(), now)).toBe("3h ago");
  });
});

describe("applyMode — one dial, each vendor's native vocabulary", () => {
  const codex = AGENT_CLIS.codex;
  const claude = AGENT_CLIS["claude-code"];

  it("standard leaves args untouched", () => {
    const args = codex.runArgs("do x");
    expect(applyMode(codex, args, "standard")).toEqual(args);
  });

  it("full unlocks each vendor's own switch", () => {
    expect(applyMode(codex, codex.runArgs("t"), "full")).toContain("danger-full-access");
    const c = applyMode(claude, claude.runArgs("t"), "full");
    expect(c).toContain("--dangerously-skip-permissions");
    expect(c).not.toContain("--permission-mode"); // replaced, not stacked
  });

  it("safe cuts Claude's shell and network tools; codex stays sandboxed", () => {
    const c = applyMode(claude, claude.runArgs("t"), "safe");
    expect(c).toContain("--disallowedTools");
    expect(c).toContain("Bash");
    expect(applyMode(codex, codex.runArgs("t"), "safe")).toContain("workspace-write");
  });

  it("review makes the reviewer read-only — a reviewer that can edit isn't a reviewer", () => {
    expect(applyMode(codex, codex.runArgs("t"), "review")).toContain("read-only");
    const c = applyMode(claude, claude.runArgs("t"), "review");
    expect(c).toContain("Edit");
    expect(c).toContain("Write");
    expect(c).toContain("NotebookEdit");
    expect(c).toContain("Bash");
    // Every deny rule must name a tool the CLI actually has — a rule that
    // matches nothing looks like protection while providing none.
    expect(c).not.toContain("MultiEdit");
  });
});
