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
    runArgs: (p) => ["exec", "--sandbox", "workspace-write", p],
    continueArgs: (p) => ["exec", "--sandbox", "workspace-write", `You just made edits in this repository. ${p}`],
  },
};

/** Installers often drop binaries in ~/.local/bin, which may not be on PATH yet. */
export function pathWithLocalBin(): string {
  const local = nodePath.join(os.homedir(), ".local", "bin");
  const current = process.env.PATH ?? "";
  return current.split(":").includes(local) ? current : `${local}:${current}`;
}

export async function runAgent(agent: AgentCliDef, root: string, prompt: string): Promise<string> {
  return invoke(agent, root, agent.runArgs(prompt));
}

export async function continueAgent(agent: AgentCliDef, root: string, prompt: string): Promise<string> {
  return invoke(agent, root, agent.continueArgs(prompt));
}

async function invoke(agent: AgentCliDef, root: string, args: string[]): Promise<string> {
  const result = await execa(agent.bin, args, {
    cwd: root,
    reject: false,
    timeout: AGENT_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0", PATH: pathWithLocalBin() },
  });
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout || "unknown error").toString().slice(-600);
    throw new Error(`${agent.bin} failed: ${tail}`);
  }
  return (result.stdout ?? "").toString().trim();
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
