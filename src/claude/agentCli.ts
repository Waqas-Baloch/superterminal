import os from "node:os";
import nodePath from "node:path";
import { execa } from "execa";
import { statusLine } from "../report/status";
import type { AgentCliId } from "../util/globalConfig";

const AGENT_TIMEOUT_MS = 900_000; // 15 min — headless runs on hard tasks take a while

interface ToolBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; path?: string; command?: string; pattern?: string; query?: string; url?: string };
}

// Present-continuous labels so a step reads as a live action ("Writing …").
const TOOL_VERB: Record<string, string> = {
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Read: "Reading",
  Bash: "Running",
  Glob: "Finding",
  Grep: "Searching",
  WebFetch: "Fetching",
  WebSearch: "Searching",
  Task: "Delegating",
  TodoWrite: "Planning",
};

/** One short, path-relative line describing what the agent is doing right now. */
function stepLabel(b: ToolBlock): string {
  const verb = TOOL_VERB[b.name ?? ""] ?? b.name ?? "Working";
  const input = b.input ?? {};
  const isPath = Boolean(input.file_path || input.path);
  const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? "";
  return `→ ${verb}${target ? ` ${shortTarget(String(target), isPath)}` : ""}`;
}

function shortTarget(target: string, isPath: boolean): string {
  let t = target;
  if (isPath && t.startsWith(`${process.cwd()}/`)) t = t.slice(process.cwd().length + 1);
  return t.length > 60 ? `…${t.slice(-57)}` : t;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Pull token usage out of whatever shape an agent reports it in. */
function usageFrom(o: unknown): AgentUsage | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, number | undefined>;
  const inp = num(r.input_tokens) ?? num(r.prompt_tokens);
  const out = num(r.output_tokens) ?? num(r.completion_tokens);
  if (inp == null && out == null) return null;
  return {
    inputTokens: (inp ?? 0) + (num(r.cache_creation_input_tokens) ?? 0) + (num(r.cache_read_input_tokens) ?? 0),
    outputTokens: out ?? 0,
    costUsd: num(r.total_cost_usd),
  };
}

/**
 * One parser for every agent's line-delimited JSON. Handles the Claude Code /
 * Cursor stream-json shape (assistant messages + a result event) and Codex's
 * event shape ({id, msg:{type,…}} / {type, item:{…}}), then falls back to a
 * generic field scan. Returns a step to show, narration text (suppressed live),
 * or usage. Unknown lines return null and the caller keeps the wave running —
 * so an unrecognized schema degrades to "thinking then diff", never a blank
 * screen or a code dump.
 */
export function parseAgentEvent(line: string): { step?: string; text?: string; usage?: AgentUsage } | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }

  // 1. Claude Code / Cursor: assistant messages + a final result event.
  const message = o.message as { content?: ToolBlock[] } | undefined;
  if (o.type === "assistant" && Array.isArray(message?.content)) {
    let step: string | undefined;
    let text = "";
    for (const b of message.content) {
      if (b.type === "tool_use") step = stepLabel(b);
      else if (b.type === "text" && b.text) text += b.text;
    }
    return step ? { step } : text ? { text } : null;
  }
  if (o.type === "result") {
    const u = usageFrom(o.usage) ?? { inputTokens: 0, outputTokens: 0 };
    if (typeof o.total_cost_usd === "number") u.costUsd = o.total_cost_usd;
    return { usage: u };
  }

  // 2. Codex events. The real schema (captured from `codex exec --json`):
  //    { type: "item.started"|"item.completed", item: { type, … } } for actions,
  //    { type: "turn.completed", usage: {…} } for tokens. Older builds wrap the
  //    payload as { msg: {…} }, so unwrap that too and keep a generic fallback.
  const msg = (o.msg && typeof o.msg === "object" ? o.msg : o) as Record<string, unknown>;
  const item = (msg.item && typeof msg.item === "object" ? msg.item : {}) as Record<string, unknown>;
  const type = String(msg.type ?? o.type ?? "");
  const itemType = String(item.type ?? "");

  const u = usageFrom(o.usage) ?? usageFrom(msg) ?? usageFrom((msg.info as Record<string, unknown>)?.total_token_usage);
  if (u && /token|usage|complete/i.test(type)) return { usage: u };

  // A file_change item carries changes as an ARRAY of { path, kind }. Calling
  // Object.keys on that array yields "0", which is why edits used to render as
  // "→ Editing 0". Read the paths out of the array.
  if (itemType === "file_change" || Array.isArray(item.changes)) {
    const paths = ((item.changes as Array<{ path?: string }>) ?? []).map((c) => c?.path).filter(Boolean) as string[];
    if (paths.length) {
      return { step: `→ Editing ${shortTarget(paths[0], true)}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ""}` };
    }
  }

  const cmd = item.command ?? msg.command;
  if (cmd && (itemType === "command_execution" || /begin|start|exec|command/i.test(type))) {
    return { step: `→ Running ${shortTarget(unwrapShell(cmd), false)}` };
  }

  // agent_message / reasoning text → narration (suppressed live; diff shows code).
  const t = item.text ?? msg.message ?? msg.text;
  if (typeof t === "string" && t.trim()) return { text: t };

  // Fallbacks for object-shaped changes and flat file fields (older schemas).
  const changes = (msg.changes ?? item.changes) as Record<string, unknown> | undefined;
  if (changes && !Array.isArray(changes) && typeof changes === "object") {
    const paths = Object.keys(changes);
    if (paths.length) return { step: `→ Editing ${shortTarget(paths[0], true)}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ""}` };
  }
  const fp = msg.file_path ?? msg.path ?? item.path;
  if (fp && /patch|file|edit|write|apply/i.test(type)) return { step: `→ Editing ${shortTarget(String(fp), true)}` };

  return null;
}

/** Codex runs shell steps as `/bin/zsh -lc "the real command"`; show the inner command. */
function unwrapShell(cmd: unknown): string {
  const s = Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
  const m = s.match(/\s-lc\s+(["'])([\s\S]+)\1\s*$/);
  return m ? m[2] : s;
}

/** Real token/cost usage as reported by the agent CLI itself (no API key needed). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** What a run produced: real usage plus the agent's narration (for flow steps). */
export interface AgentRunResult {
  usage: AgentUsage | null;
  text: string;
}

/**
 * Passthrough providers: the manifest becomes the prompt for a headless agent
 * CLI run. The agent brings its own auth (subscriptions work — no API key),
 * applies edits itself, and Super Terminal tracks/undoes changes through git.
 */
export interface AgentCliDef {
  id: AgentCliId;
  title: string;
  bin: string;
  installCmd: string; // shown to the user; may contain a pipe, so never executed as a string
  // Present only when the install can run WITHOUT a shell. Absent means the
  // vendor's method pipes a downloaded script into a shell (`curl … | bash`),
  // which Super Terminal will display but refuses to execute on your behalf.
  installArgs?: string[];
  installHint: string;
  loginArgs: string[] | null; // interactive login after install; null = manual
  loginHint: string;
  // How to ask this CLI whether it is actually signed in. `doctor` used to probe
  // with `--version` alone and so showed a green light for an agent that was
  // installed but logged out — a false all-clear from the one command whose job
  // is answering "why isn't this working".
  //
  // Exit codes are useless here: `cursor-agent status` exits 0 while printing
  // "Not logged in". So match the text, and match the NEGATIVE signal — an
  // unrecognized response means "assume fine" rather than a false alarm.
  //
  // Privacy: some of these responses carry the account's email and org id
  // (`claude auth status` does). Only the boolean may ever leave this function —
  // never log the output, never put it in telemetry.
  authProbe?: { args: string[]; loggedOut: RegExp };
  billingNote: string;
  runArgs: (prompt: string) => string[];
  continueArgs: (prompt: string) => string[];
  // Some agents can emit structured output carrying their true token usage. When
  // set, Super Terminal runs in that mode, renders the text itself, and captures usage —
  // the accurate, subscription-friendly number (the agent counted it, not us).
  jsonUsage?: {
    args: string[]; // extra flags to switch the CLI into line-delimited JSON
    // step  → the agent's current action, shown on one updating status line
    // text  → narration (suppressed during the run; the diff shows the code)
    // usage → real token counts
    parse: (line: string) => { step?: string; text?: string; usage?: AgentUsage } | null;
  };
  // Experimental "surgical" mode (Step 0): restrict the agent to a direct edit
  // with no repo exploration, to measure how much of the token cost is the
  // agent's own discovery loop rather than the manifest. Read+Edit stay enabled
  // (Claude Code's Edit requires a prior Read); search/exec tools are cut.
  surgicalArgs?: string[];
}

// One safety dial, translated to each agent's native vocabulary.
//   safe     → the agent keeps its sandbox AND loses shell/network tools
//   standard → each agent's sandboxed default (today's behavior)
//   full     → the agent's own "skip permissions" switch; explicit opt-in only
//   review   → internal: read-only, for Second Opinion reviewers — a reviewer
//              that can edit isn't a reviewer
export type SafetyMode = "safe" | "standard" | "full" | "review";

export function applyMode(agent: AgentCliDef, args: string[], mode: SafetyMode): string[] {
  if (mode === "standard") return args;
  const out = [...args];
  if (agent.id === "codex") {
    const i = out.indexOf("--sandbox");
    if (i >= 0 && i + 1 < out.length) {
      if (mode === "full") out[i + 1] = "danger-full-access";
      if (mode === "review") out[i + 1] = "read-only";
      // safe: workspace-write already blocks network — unchanged
    }
    return out;
  }
  if (agent.id === "claude-code") {
    if (mode === "full") {
      const i = out.indexOf("--permission-mode");
      if (i >= 0) out.splice(i, 2);
      out.push("--dangerously-skip-permissions");
    }
    if (mode === "safe") out.push("--disallowedTools", "Bash", "WebFetch", "WebSearch");
    // Verified against the CLI: these four are live deny rules. "MultiEdit" is
    // not a tool any more and produced a "matches no known tool" warning —
    // a dead rule in a security guard is worse than no rule, because it reads
    // like protection.
    if (mode === "review") out.push("--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash");
    return out;
  }
  if (agent.id === "cursor") {
    // Verified against cursor-agent 2026.07.16-899851b: `--mode ask|plan` are
    // read-only execution modes, `--sandbox enabled|disabled` is a real flag,
    // and both compose with `-p` and `--output-format stream-json`.
    //
    // Before this branch existed, applyMode returned Cursor's args untouched, so
    // ALL FOUR modes sent the identical argv — `-p TASK --force`. That meant
    // "review" ran the reviewer with "allow every command", and the safety dial
    // silently did nothing.
    if (mode === "review") {
      // A reviewer that can edit isn't a reviewer. Strip the allow-everything
      // switch and ask for the read-only mode. Note this flag is a promise from a
      // CLI we don't ship, so it is NOT the guarantee — containReviewer() in
      // core/review.ts verifies the outcome instead.
      //
      // Skip the prompt's own slot: it is free text (a manifest, a ticket title)
      // and a plain indexOf would happily delete a prompt that equals "--force",
      // leaving the real flag in place. `--yolo` is cursor-agent's documented
      // alias for --force, so it has to go too.
      const promptAt = out.indexOf("-p") + 1;
      for (let i = out.length - 1; i >= 0; i--) {
        if (i !== promptAt && (out[i] === "--force" || out[i] === "--yolo")) out.splice(i, 1);
      }
      out.push("--mode", "ask");
    }
    if (mode === "safe") out.push("--sandbox", "enabled");
    if (mode === "full") out.push("--sandbox", "disabled");
    return out;
  }
  return out;
}

/** Compose the final argv: base args + mode translation + JSON-usage flags + surgical restrictions. */
export function composeArgs(agent: AgentCliDef, baseArgs: string[], surgical: boolean, mode: SafetyMode = "standard"): string[] {
  const out = applyMode(agent, [...baseArgs], mode);
  if (agent.jsonUsage) out.push(...agent.jsonUsage.args);
  // surgicalArgs go last: Claude Code's --disallowedTools is variadic and would
  // otherwise swallow following flags. (When surgical is on, its tool cuts
  // supersede safe-mode's — both remove the discovery/exec tools.)
  if (surgical && agent.surgicalArgs) out.push(...agent.surgicalArgs);
  return out;
}

/** A vendor refused work because a usage/rate limit was hit — the one failure
 * failover may act on. Anything else stays a plain error: auto-retrying a
 * genuine bug on a second vendor would just spend a second vendor's quota. */
export class AgentLimitError extends Error {
  constructor(
    public agentId: AgentCliId,
    detail: string,
  ) {
    super(`${agentId} hit its usage limit${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    this.name = "AgentLimitError";
  }
}

const LIMIT_RE =
  /usage limit|rate.?limit|limit (reached|exceeded)|quota (exceeded|reached)|insufficient_quota|out of (credits|quota)|too many requests|429|upgrade to continue|hit your .*limit|exceeded your current/i;

/** Does this error text look like a vendor usage limit (vs a real failure)? */
export function isLimitError(text: string): boolean {
  return LIMIT_RE.test(text);
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
    // Emits JSON: {"loggedIn":true,"authMethod":…,"email":…}. Only the flag is read.
    authProbe: { args: ["auth", "status"], loggedOut: /"loggedIn"\s*:\s*false/i },
    billingNote: "covered by your Claude Code login/subscription",
    runArgs: (p) => ["-p", p, "--permission-mode", "acceptEdits"],
    continueArgs: (p) => ["-c", "-p", p, "--permission-mode", "acceptEdits"],
    // Cut discovery/exec tools; keep Read+Edit+Write so the edit still applies.
    surgicalArgs: ["--disallowedTools", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "TodoWrite"],
    // stream-json emits one JSON event per line; the final `result` event
    // carries real token usage and total_cost_usd — even on a subscription.
    jsonUsage: { args: ["--output-format", "stream-json", "--verbose"], parse: parseAgentEvent },
  },
  cursor: {
    id: "cursor",
    title: "Cursor",
    bin: "cursor-agent",
    installCmd: "curl https://cursor.com/install -fsS | bash",
    installHint: "install: curl https://cursor.com/install -fsS | bash",
    loginArgs: ["login"],
    loginHint: "run `cursor-agent login`",
    // Verified live: `cursor-agent status` prints exactly "Not logged in", exit 0.
    authProbe: { args: ["status"], loggedOut: /not logged in|authentication required/i },
    billingNote: "covered by your Cursor subscription",
    runArgs: (p) => ["-p", p, "--force"],
    // `--continue` IS a real, working flag (verified: it returns "No previous
    // chats found." rather than an unknown-option error), but it resumes
    // cursor-agent's own last chat in this directory, which is not necessarily
    // OUR last run — another terminal or a manual `cursor-agent` call would win.
    // Restating the situation in the prompt is less elegant and more correct.
    continueArgs: (p) => ["-p", `You just made edits in this repository. ${p}`, "--force"],
    // Flags verified against cursor-agent 2026.07.16-899851b. The stream-json
    // EVENT SCHEMA is still unverified (needs a logged-in account); if it differs
    // from Claude Code's, the shared parser just won't recognize events and the
    // run degrades to the wave + diff — never a blank screen.
    jsonUsage: { args: ["--output-format", "stream-json"], parse: parseAgentEvent },
  },
  codex: {
    id: "codex",
    title: "ChatGPT (Codex)",
    bin: "codex",
    installCmd: "npm install -g @openai/codex",
    installArgs: ["npm", "install", "-g", "@openai/codex"], // no shell needed
    installHint: "install: npm i -g @openai/codex (or `brew install codex`)",
    loginArgs: ["login"],
    loginHint: "run `codex login` with your ChatGPT account",
    // Verified live: prints "Logged in using ChatGPT" when authenticated.
    authProbe: { args: ["login", "status"], loggedOut: /not logged in|no credentials|please run .*login/i },
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
    // `codex exec --json` prints events as JSONL (flag confirmed from --help).
    // The event schema is best-effort; unrecognized events degrade to the wave.
    jsonUsage: { args: ["--json"], parse: parseAgentEvent },
  },
};

/** Is this agent's CLI actually on PATH? */
export async function isAgentInstalled(bin: string): Promise<boolean> {
  const r = await execa("which", [bin], { reject: false, env: { ...process.env, PATH: pathWithLocalBin() } }).catch(() => null);
  return r !== null && r.exitCode === 0;
}

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
  surgical = false,
  mode: SafetyMode = "standard",
): Promise<AgentRunResult> {
  return invoke(agent, root, agent.runArgs(prompt), onFirstOutput, surgical, mode);
}

export async function continueAgent(
  agent: AgentCliDef,
  root: string,
  prompt: string,
  onFirstOutput?: () => void,
  surgical = false,
  mode: SafetyMode = "standard",
): Promise<AgentRunResult> {
  return invoke(agent, root, agent.continueArgs(prompt), onFirstOutput, surgical, mode);
}

async function invoke(
  agent: AgentCliDef,
  root: string,
  args: string[],
  onFirstOutput?: () => void,
  surgical = false,
  mode: SafetyMode = "standard",
): Promise<AgentRunResult> {
  // Relay the agent's output live rather than inheriting it. Headless/print mode
  // has no interactive TUI to preserve — it's a stream. In plain mode we forward
  // bytes as-is; when the agent can emit line-delimited JSON (jsonUsage), we
  // parse each event, render the text ourselves, and capture the real usage the
  // agent reports. Either way we notice the first output, so the spinner can
  // cover the dead air and clear the moment real output arrives.
  //
  // stdin still inherits in a real terminal (an agent that checks stdin must not
  // deadlock); in a pipe/CI it gets EOF instead.
  const stdinMode = process.stdin.isTTY ? "inherit" : "ignore";
  const jsonMode = agent.jsonUsage;
  const child = execa(agent.bin, composeArgs(agent, args, surgical, mode), {
    cwd: root,
    reject: false,
    timeout: AGENT_TIMEOUT_MS,
    buffer: false, // stream through; don't hold the whole transcript in memory
    stdio: [stdinMode, "pipe", "pipe"],
    env: { ...process.env, PATH: pathWithLocalBin(), FORCE_COLOR: "1" },
  });

  let announced = false;
  const announce = (): void => {
    if (!announced) {
      announced = true;
      onFirstOutput?.();
    }
  };
  let usage: AgentUsage | null = null;
  let text = ""; // the agent's narration — suppressed on screen, kept for flow steps
  let errTail = ""; // last stderr bytes, kept to recognize a usage-limit refusal
  const keepTail = (chunk: Buffer): void => {
    errTail = (errTail + chunk.toString()).slice(-2000);
  };
  const status = jsonMode ? statusLine() : null;

  if (jsonMode && status) {
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const r = jsonMode.parse(line);
        if (r?.step) {
          announce();
          status.set(r.step); // one updating line, current action, shimmering
        } else if (!r && !line.trimStart().startsWith("{")) {
          // Safety net: the CLI didn't honor JSON mode — forward raw so the
          // user never sees a blank screen.
          announce();
          status.stop();
          process.stdout.write(`${line}\n`);
        }
        // r.text (narration) is suppressed on screen but captured for flows.
        if (r?.text) text += r.text.endsWith("\n") ? r.text : `${r.text}\n`;
        if (r?.usage) usage = r.usage;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      keepTail(chunk);
      announce();
      status.stop();
      process.stderr.write(chunk);
    });
  } else {
    const relay = (from: NodeJS.ReadableStream | null | undefined, to: NodeJS.WritableStream): void => {
      from?.on("data", (chunk: Buffer) => {
        announce();
        to.write(chunk);
      });
    };
    relay(child.stdout, process.stdout);
    child.stderr?.on("data", (chunk: Buffer) => {
      keepTail(chunk);
      announce();
      process.stderr.write(chunk);
    });
  }

  const result = await child;
  status?.stop();
  if (result.exitCode !== 0) {
    // A limit refusal is not a failure of the task — it's a vendor saying "not
    // now". Surface it as its own type so callers can fail over safely.
    if (isLimitError(errTail) || isLimitError(text)) throw new AgentLimitError(agent.id, errTail.trim() || text.trim());
    throw new Error(`${agent.bin} exited with code ${result.exitCode} (see its output above)`);
  }
  return { usage, text: text.trim() };
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
    ["-c", "user.email=super-t@local", "-c", "user.name=super-t", "commit", "-qm", "super-t: baseline before run", "--no-verify"],
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
