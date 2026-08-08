import { describe, it, expect } from "vitest";
import { detectAvailability, providerChoices, isSignedOut } from "../src/commands/provider";
import { AGENT_CLIS, isAgentInstalled, type AgentCliDef } from "../src/claude/agentCli";

// `super-t connect` on Windows told people an agent was connected without ever
// opening a browser — the single worst thing this command can do, because the
// user then has no reason to look at it again and the failure surfaces later as
// an unrelated auth error mid-task.
//
// The cause was a second implementation. commit 934ea29 replaced the
// `<bin> --version` existence check with a PATH walk everywhere it appeared,
// but connect's copy lived in src/commands/provider.ts and was missed. On
// Windows a missing command is run through cmd.exe, which exits with a code
// like any other process, so the old check reported EVERY agent as installed:
// install and login were skipped, the auth probe questioned a binary that was
// not there, and connect saved the provider and declared success.
//
// These tests exist to keep the connect path on the one resolver. The first two
// only diverge on Windows, which is where the bug lived and where CI runs.

describe("connect resolves binaries the same way as the rest of the CLI", () => {
  it("reports agents as installed exactly when the shared resolver does", async () => {
    const { installed } = await detectAvailability();
    for (const agent of Object.values(AGENT_CLIS)) {
      expect(installed[agent.id], `${agent.bin} availability`).toBe(await isAgentInstalled(agent.bin));
    }
  });

  it("does not claim the `ant` CLI exists when it is not on PATH", async () => {
    // Offering browser login for a CLI that isn't installed sends the user into
    // an `ant auth login` that cannot run.
    const { hasAnt } = await detectAvailability();
    expect(hasAnt).toBe(await isAgentInstalled("ant"));
  });

  it("labels an agent that is not installed", () => {
    const choices = providerChoices({ hasAnt: false, installed: {} });
    const cursor = choices.find((c) => c.value === "cursor");
    expect(cursor?.title).toContain("not installed yet");
    expect(choices.find((c) => c.value === "oauth")?.disabled).toBe(true);
  });
});

describe("isSignedOut", () => {
  // Deterministic on every platform: no subprocess decides this one.
  const missing: AgentCliDef = { ...AGENT_CLIS.cursor, bin: "definitely-not-a-real-agent-xyz" };

  it("never reports a CLI that isn't installed as signed in", async () => {
    // The old answer here was `false` — "assume fine" — which is what let
    // connect certify an agent the machine did not have. A CLI that cannot be
    // run cannot be logged in.
    expect(await isSignedOut(missing)).toBe(true);
  });

  it("stays lenient when there is nothing to probe with", async () => {
    // No authProbe means no opinion — it must not become a false alarm.
    const unprobed: AgentCliDef = { ...AGENT_CLIS.cursor, authProbe: undefined };
    expect(await isSignedOut(unprobed)).toBe(false);
  });

  it("treats an unrecognized reply as signed in", async () => {
    // `node --version` prints a version string, which matches no logged-out
    // pattern. That must read as "fine", not as a login prompt: the probe's job
    // is catching a known negative signal, not vouching for a positive one.
    const nodeAgent: AgentCliDef = {
      ...AGENT_CLIS.cursor,
      bin: process.execPath,
      authProbe: { args: ["--version"], loggedOut: /not logged in/i },
    };
    expect(await isSignedOut(nodeAgent)).toBe(false);
  });

  it("recognizes the logged-out signal in real output", async () => {
    // Proves the probe reads the text rather than the exit code: this exits 0.
    const sayingLoggedOut: AgentCliDef = {
      ...AGENT_CLIS.cursor,
      bin: process.execPath,
      authProbe: { args: ["-e", "console.log('Not logged in')"], loggedOut: /not logged in/i },
    };
    expect(await isSignedOut(sayingLoggedOut)).toBe(true);
  });
});
