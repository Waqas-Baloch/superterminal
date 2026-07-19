import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scrub, isEnabled, setEnabled, status, track } from "../src/util/telemetry";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "glint-tel-"));
  process.env.GLINT_HOME = home;
  delete process.env.GLINT_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
});
afterEach(async () => {
  delete process.env.GLINT_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("scrub — nothing a person typed can ever leave the machine", () => {
  it("drops any field not on the allowlist", () => {
    expect(
      scrub({
        agent: "claude-code",
        task: "remove the button in the navbar", // the user's prompt
        file: "src/components/Hero.tsx",
        path: "/Users/someone/secret-project",
        diff: "- const KEY = 'sk-live-123'",
        repoName: "acme-internal",
      } as never),
    ).toEqual({ agent: "claude-code" });
  });

  it("replaces free text in an allowed field rather than truncating it", () => {
    // A truncated prompt is still a prompt — it must not survive at all.
    expect(scrub({ command: "delete the pricing page copy" })).toEqual({ command: "other" });
    expect(scrub({ outcome: "user said: my api key is sk-live-abc" })).toEqual({ outcome: "other" });
  });

  it("keeps Glint's own fixed tokens", () => {
    expect(scrub({ command: "flow", agent: "codex", outcome: "applied", band: "green" })).toEqual({
      command: "flow",
      agent: "codex",
      outcome: "applied",
      band: "green",
    });
  });

  it("rejects a version string that isn't a version", () => {
    expect(scrub({ version: "1.0.38" })).toEqual({ version: "1.0.38" });
    expect(scrub({ version: "/Users/me/secret" })).toEqual({});
  });

  it("keeps counts, and never a non-finite number", () => {
    expect(scrub({ steps: 3, files: 12 })).toEqual({ steps: 3, files: 12 });
    expect(scrub({ steps: Number.NaN })).toEqual({});
    expect(scrub({ steps: 2.7 })).toEqual({ steps: 3 });
  });

  it("keeps booleans", () => {
    expect(scrub({ substituted: true })).toEqual({ substituted: true });
  });

  it("ignores undefined instead of sending null", () => {
    expect(scrub({ agent: undefined, steps: 1 })).toEqual({ steps: 1 });
  });

  it("lets a filename through no route at all", () => {
    // Every plausible way a path could be smuggled in.
    // These are all made of "safe" characters — which is exactly why a
    // character-based filter is not enough and the fields are enumerated.
    for (const value of ["landing-page.md", "src/app/page.tsx", "../../.env", "/etc/passwd", "acme-internal"]) {
      const out = scrub({ agent: value, command: value, code: value, outcome: value, band: value, os: value });
      expect(Object.values(out)).toEqual(["other", "other", "other", "other", "other", "other"]);
    }
  });
});

describe("the off switch", () => {
  it("is on by default", async () => {
    expect(await isEnabled()).toBe(true);
  });

  it("stays off once turned off", async () => {
    await setEnabled(false);
    expect(await isEnabled()).toBe(false);
    await setEnabled(true);
    expect(await isEnabled()).toBe(true);
  });

  it("honors GLINT_TELEMETRY=0 and DO_NOT_TRACK", async () => {
    process.env.GLINT_TELEMETRY = "0";
    expect(await isEnabled()).toBe(false);
    delete process.env.GLINT_TELEMETRY;
    process.env.DO_NOT_TRACK = "1";
    expect(await isEnabled()).toBe(false);
  });

  it("never counts CI machines as users", async () => {
    process.env.CI = "true";
    expect(await isEnabled()).toBe(false);
  });
});

describe("safety — analytics must never break or slow a command", () => {
  it("sends nothing when no key is configured", async () => {
    const s = await status();
    expect(s.collecting).toBe(false); // shipped build makes zero outbound calls
  });

  it("resolves quietly even with an unreachable endpoint", async () => {
    process.env.GLINT_TELEMETRY_KEY = "test";
    process.env.GLINT_TELEMETRY_HOST = "http://127.0.0.1:1"; // nothing listening
    await expect(track("task_completed", null, { command: "run" })).resolves.toBeUndefined();
    delete process.env.GLINT_TELEMETRY_KEY;
    delete process.env.GLINT_TELEMETRY_HOST;
  });

  it("keeps a stable anonymous id across calls", async () => {
    const a = await status();
    const b = await status();
    expect(a.installId).toBe(b.installId);
    expect(a.installId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
