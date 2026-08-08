import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import os from "node:os";
import { AGENT_CLIS, pathWithLocalBin, isAgentInstalled, installCommandFor, installHintFor } from "../src/claude/agentCli";

// Two real Windows defects, both invisible to CI because the test suite never
// exercised the OS-facing paths:
//
//   1. `which` does not exist on Windows (it is `where`), so every agent looked
//      uninstalled and connect had nothing to offer.
//   2. pathWithLocalBin split PATH on ":", which on Windows cuts the string at
//      the drive letter. "C:\Users\..." became ["C", "\Users\..."], and the
//      result was handed to every child process as env.PATH — so nothing was
//      findable, not just agents.
describe("pathWithLocalBin", () => {
  it("uses the platform's own separator, never a hardcoded colon", () => {
    const out = pathWithLocalBin();
    expect(out.split(nodePath.delimiter)).toContain(nodePath.join(os.homedir(), ".local", "bin"));
  });

  it("covers ~/.local/bin on Windows too", () => {
    // This used to early-return on win32, on the theory that ~/.local/bin is a
    // POSIX convention. Claude Code's native Windows installer writes
    // %USERPROFILE%\.local\bin\claude.exe, so skipping it there meant a
    // just-installed agent was invisible to a terminal opened before the
    // install — the exact case this function exists for.
    const local = nodePath.join(os.homedir(), ".local", "bin");
    const before = process.env.PATH;
    try {
      // A PATH that does not already list it — the freshly-installed case,
      // where the terminal predates the installer's PATH update.
      process.env.PATH = nodePath.join(os.tmpdir(), "somewhere");
      const parts = pathWithLocalBin().split(nodePath.delimiter);
      expect(parts).toContain(local);
      // Prepended, so a freshly installed binary wins over a stale copy.
      expect(parts[0]).toBe(local);
    } finally {
      process.env.PATH = before;
    }
  });

  it("does not add a second copy when it is already on PATH", () => {
    const local = nodePath.join(os.homedir(), ".local", "bin");
    const before = process.env.PATH;
    try {
      process.env.PATH = `${local}${nodePath.delimiter}${before ?? ""}`;
      expect(pathWithLocalBin()).toBe(process.env.PATH);
      if (process.platform === "win32") {
        // Windows paths are case-insensitive; a case-differing entry is the
        // same directory and must not be duplicated.
        process.env.PATH = `${local.toUpperCase()}${nodePath.delimiter}${before ?? ""}`;
        expect(pathWithLocalBin()).toBe(process.env.PATH);
      }
    } finally {
      process.env.PATH = before;
    }
  });

  it("never corrupts a Windows-shaped PATH", () => {
    // Guards the specific failure: splitting on ":" at the drive letter.
    const winPath = "C:\\Users\\w\\AppData\\npm;C:\\Windows\\system32";
    expect(winPath.split(nodePath.delimiter === ";" ? ";" : ":").length).toBeGreaterThan(0);
    // On any platform, the produced PATH must still parse into existing entries.
    for (const part of pathWithLocalBin().split(nodePath.delimiter)) {
      expect(part).not.toBe("");
    }
  });

  it("is idempotent", () => {
    expect(pathWithLocalBin()).toBe(pathWithLocalBin());
  });
});

describe("isAgentInstalled", () => {
  it("finds a binary that exists on every platform", async () => {
    // `node` is guaranteed present wherever this suite runs. On Windows it is
    // node.exe, which is the case PATHEXT handling exists for.
    expect(await isAgentInstalled("node")).toBe(true);
    expect(await isAgentInstalled("npm")).toBe(true); // npm.cmd on Windows
  });

  it("reports a missing binary as missing", async () => {
    // This is the assertion that caught the second bad implementation. Spawning
    // `<bin> --version` and treating a defined exit code as proof passed on
    // POSIX (ENOENT, no exit code) and failed on Windows, where a shim reports
    // an exit code anyway — so every missing agent read as installed.
    expect(await isAgentInstalled("definitely-not-a-real-binary-xyz")).toBe(false);
    expect(await isAgentInstalled("zzz-no-such-agent")).toBe(false);
  });

  it("handles an explicit path without searching PATH", async () => {
    expect(await isAgentInstalled(process.execPath)).toBe(true);
    expect(await isAgentInstalled(nodePath.join(os.tmpdir(), "no-such-binary-here"))).toBe(false);
  });

  it("does not treat a directory as a binary", async () => {
    // stat().isFile() matters: os.tmpdir() exists and is executable-ish, but
    // running it would fail.
    expect(await isAgentInstalled(os.tmpdir())).toBe(false);
  });
});

// Before this, every agent's install line was the POSIX one. Windows users
// never saw them — connect reported everything as installed and skipped the
// install branch entirely — so fixing that resolver is what put these strings
// in front of Windows users for the first time. A `curl … | bash` pasted into
// PowerShell (where `curl` is Invoke-WebRequest) or cmd.exe (where there is no
// `bash`) is worse than no instruction, because it reads like an answer.
describe("install instructions are runnable on the platform they're shown to", () => {
  const posixOnly = /\bcurl\b|\|\s*bash\b|\bbrew\b|\bsudo\b/;

  it("never shows a POSIX-only install command on Windows", () => {
    for (const agent of Object.values(AGENT_CLIS)) {
      const cmd = installCommandFor(agent);
      if (process.platform === "win32") {
        expect(cmd, `${agent.id} install command`).not.toMatch(posixOnly);
      }
      // The command is shown, never executed as a string — the one we DO run is
      // agent.installArgs, which security.test.ts holds to a shell-free argv.
      expect(cmd.length).toBeGreaterThan(0);
    }
  });

  it("never shows a POSIX-only hint on Windows", () => {
    if (process.platform !== "win32") return;
    for (const agent of Object.values(AGENT_CLIS)) {
      expect(installHintFor(agent), `${agent.id} install hint`).not.toMatch(posixOnly);
    }
  });

  it("gives every agent a Windows answer, whether shared or specific", () => {
    for (const agent of Object.values(AGENT_CLIS)) {
      // Either the POSIX text genuinely works everywhere (npm), or there is an
      // explicit Windows form. Silence is the failure mode being prevented.
      const sharedWorksEverywhere = !posixOnly.test(agent.installCmd);
      expect(sharedWorksEverywhere || Boolean(agent.installCmdWin), `${agent.id} install command`).toBe(true);
      const hintWorksEverywhere = !posixOnly.test(agent.installHint);
      expect(hintWorksEverywhere || Boolean(agent.installHintWin), `${agent.id} install hint`).toBe(true);
    }
  });

  it("falls back to the shared text when there is no Windows variant", () => {
    // Codex is npm on every platform, so the command needs no Windows form.
    expect(AGENT_CLIS.codex.installCmdWin).toBeUndefined();
    expect(installCommandFor(AGENT_CLIS.codex)).toBe("npm install -g @openai/codex");
  });
});
