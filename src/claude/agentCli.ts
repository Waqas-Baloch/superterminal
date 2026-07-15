import os from "node:os";
import nodePath from "node:path";
import { execa } from "execa";
import type { AgentCliId } from "../util/globalConfig";

const AGENT_TIMEOUT_MS = 900_000; // 15 min — headless runs on hard tasks take a while

/**
 * Passthrough providers: the manifest becomes the prompt for a headless agent
 * CLI run. The agent brings its own auth (subscriptions work — no API key),
 * applies edits itself, and glint tracks/undoes changes through git.
 */
export interface AgentCliDef {
  id: AgentCliId;
  title: string;
  bin: string;
  installCmd: string; // shell command for `glint connect` to offer
  installHint: string;
  loginArgs: string[] | null; // interactive login after install; null = manual
  loginHint: string;
  billingNote: string;
  runArgs: (prompt: string) => string[];
  continueArgs: (prompt: string) => string[];
}

export const AGENT_CLIS: Record<AgentCliId, AgentCliDef> = {
  "claude-code": {
    id: "claude-code",
    title: "Claude Code",
    bin: "claude",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    installHint: "install from claude.com/claude-code",
    loginArgs: null, // login runs inside the interactive TUI
    loginHint: "run `claude` once and log in with your Claude account",
    billingNote: "covered by your Claude Code login/subscription",
    runArgs: (p) => ["-p", p, "--permission-mode", "acceptEdits"],
    continueArgs: (p) => ["-c", "-p", p, "--permission-mode", "acceptEdits"],
  },
  cursor: {
    id: "cursor",
    title: "Cursor",
    bin: "cursor-agent",
    installCmd: "curl https://cursor.com/install -fsS | bash",
    installHint: "install: curl https://cursor.com/install -fsS | bash",
    loginArgs: ["login"],
    loginHint: "run `cursor-agent login`",
    billingNote: "covered by your Cursor subscription",
    runArgs: (p) => ["-p", p, "--force"],
    // cursor-agent has no reliable headless resume — repo state + error text carry the context
    continueArgs: (p) => ["-p", `You just made edits in this repository. ${p}`, "--force"],
  },
  codex: {
    id: "codex",
    title: "ChatGPT (Codex)",
    bin: "codex",
    installCmd: "npm install -g @openai/codex",
    installHint: "install: npm i -g @openai/codex (or `brew install codex`)",
    loginArgs: ["login"],
    loginHint: "run `codex login` with your ChatGPT account",
    billingNote: "covered by your ChatGPT plan",
    // --skip-git-repo-check lets Codex run in folders that aren't git repos
    runArgs: (p) => ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", p],
    continueArgs: (p) => [
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      `You just made edits in this repository. ${p}`,
    ],
  },
};

/** Installers often drop binaries in ~/.local/bin, which may not be on PATH yet. */
export function pathWithLocalBin(): string {
  const local = nodePath.join(os.homedir(), ".local", "bin");
  const current = process.env.PATH ?? "";
  return current.split(":").includes(local) ? current : `${local}:${current}`;
}

export async function runAgent(
  agent: AgentCliDef,
  root: string,
  prompt: string,
  onFirstOutput?: () => void,
): Promise<void> {
  return invoke(agent, root, agent.runArgs(prompt), onFirstOutput);
}

export async function continueAgent(
  agent: AgentCliDef,
  root: string,
  prompt: string,
  onFirstOutput?: () => void,
): Promise<void> {
  return invoke(agent, root, agent.continueArgs(prompt), onFirstOutput);
}

async function invoke(agent: AgentCliDef, root: string, args: string[], onFirstOutput?: () => void): Promise<void> {
  // Relay the agent's output live rather than inheriting it. Every agent here
  // runs headless/print mode (`claude -p`, `cursor-agent -p`, `codex exec`), so
  // there's no interactive TUI to preserve — it's a text stream. Proxying it
  // costs nothing visually (FORCE_COLOR keeps the colors) and buys one thing:
  // we can see the *first* byte, which is what tells the caller the agent has
  // stopped thinking and started talking — so a spinner can cover the dead air
  // and get out of the way the moment real output arrives.
  //
  // stdin still inherits in a real terminal (an agent that checks stdin must
  // not deadlock); in a pipe/CI it gets EOF instead.
  const stdinMode = process.stdin.isTTY ? "inherit" : "ignore";
  const child = execa(agent.bin, args, {
    cwd: root,
    reject: false,
    timeout: AGENT_TIMEOUT_MS,
    buffer: false, // stream through; don't hold the whole transcript in memory
    stdio: [stdinMode, "pipe", "pipe"],
    env: { ...process.env, PATH: pathWithLocalBin(), FORCE_COLOR: "1" },
  });

  let announced = false;
  const relay = (from: NodeJS.ReadableStream | null | undefined, to: NodeJS.WritableStream): void => {
    from?.on("data", (chunk: Buffer) => {
      if (!announced) {
        announced = true;
        onFirstOutput?.();
      }
      to.write(chunk);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);

  const result = await child;
  if (result.exitCode !== 0) {
    throw new Error(`${agent.bin} exited with code ${result.exitCode} (see its output above)`);
  }
}

// --- git helpers (change tracking + undo for passthrough providers) --------

export async function isGitRepo(root: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function hasHeadCommit(root: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "HEAD"], { cwd: root, reject: false });
  return result.exitCode === 0;
}

export async function gitInit(root: string): Promise<void> {
  await execa("git", ["init", "-q"], { cwd: root });
}

/**
 * Commit everything as a baseline so gitBefore/undo have a HEAD to work
 * against. Identity is passed inline so it works on machines without
 * git config; --no-verify skips any hooks the project may have.
 */
export async function gitBaselineCommit(root: string): Promise<void> {
  await execa("git", ["add", "-A"], { cwd: root, reject: false });
  await execa(
    "git",
    ["-c", "user.email=glint@local", "-c", "user.name=glint", "commit", "-qm", "glint: baseline before run", "--no-verify"],
    { cwd: root, reject: false },
  );
}

/** Paths that are modified/untracked right now (used to diff before vs after a run). */
export async function gitDirtyFiles(root: string): Promise<Set<string>> {
  const result = await execa("git", ["status", "--porcelain"], { cwd: root, reject: false });
  if (result.exitCode !== 0) return new Set();
  return new Set(
    result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim()),
  );
}

/** File content at HEAD, or null if the file is new/untracked. */
export async function gitBefore(root: string, rel: string): Promise<string | null> {
  const result = await execa("git", ["show", `HEAD:${rel}`], {
    cwd: root,
    reject: false,
    stripFinalNewline: false,
  });
  return result.exitCode === 0 ? result.stdout : null;
}
