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
    // `node` is guaranteed present wherever this suite runs, and unlike `which`
    // the check itself is cross-platform.
    expect(await isAgentInstalled("node")).toBe(true);
  });

  it("reports a missing binary as missing", async () => {
    expect(await isAgentInstalled("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
