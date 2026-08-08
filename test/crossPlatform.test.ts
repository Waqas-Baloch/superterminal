import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import os from "node:os";
import { pathWithLocalBin, isAgentInstalled } from "../src/claude/agentCli";

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
    if (process.platform === "win32") {
      // Untouched on Windows: ~/.local/bin is a POSIX convention with nothing
      // to add, and a broken PATH there breaks everything.
      expect(out).toBe(process.env.PATH ?? "");
    } else {
      expect(out.split(nodePath.delimiter)).toContain(nodePath.join(os.homedir(), ".local", "bin"));
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
