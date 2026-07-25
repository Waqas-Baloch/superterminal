import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import { statePath } from "../util/paths";
import { AGENT_CLIS } from "../claude/agentCli";
import { agentFrom } from "../core/flow";
import { runCommand } from "./run";
import { log } from "../util/logger";

// `super-t resume [--with <agent>]` — continue the last piece of work in a new
// process, with ANY vendor. Codex hands threads to Codex; the neutral layer
// hands a conversation across vendors: start with Claude, continue with Codex.
// The state that carries over is what Super Terminal already owns — the task,
// what changed, and the summary — so no vendor-private session is needed.

interface SavedSession {
  task: string;
  summary: string;
  touched: string[];
  agent: string;
  at: string;
}

export async function resumeCommand(extra: string | undefined, opts: { with?: string; mode?: string }): Promise<void> {
  const root = process.cwd();
  let saved: SavedSession;
  try {
    saved = JSON.parse(await fs.readFile(statePath(root, "session.json"), "utf8"));
  } catch {
    log.error("Nothing to resume in this project — run a task first.");
    process.exitCode = 1;
    return;
  }

  const withId = opts.with ? agentFrom(opts.with) : null;
  if (opts.with && !withId) {
    log.error(`Unknown agent "${opts.with}". Use: claude, cursor, or codex.`);
    process.exitCode = 1;
    return;
  }

  const when = new Date(saved.at).toLocaleString();
  log.info("");
  log.info(`Resuming work from ${pc.bold(when)} (last agent: ${saved.agent}).`);
  if (withId && withId !== saved.agent) log.info(`${pc.cyan("↻")} Continuing with ${pc.bold(AGENT_CLIS[withId].title)} — the conversation isn't locked to a vendor.`);
  log.dim(`  Previous task: ${saved.task.split("\n")[0].slice(0, 100)}`);

  // The continuation is plain language + the file list — deliberately agent-
  // agnostic. Filenames in the task also feed selection and mention-injection.
  const task = [
    "Continue the previous work in this repository.",
    `Previous task: ${saved.task}`,
    saved.summary ? `What was done: ${saved.summary}` : "",
    saved.touched.length ? `Files changed last time: ${saved.touched.join(", ")}` : "",
    extra?.trim()
      ? `Now: ${extra.trim()}`
      : "Now: continue where that left off — verify the previous change is complete and consistent, and finish anything unfinished.",
  ]
    .filter(Boolean)
    .join("\n");

  await runCommand(task, { yes: false, mode: opts.mode, agent: withId ?? undefined });
}

/** For tests: where the session is stored and its shape. */
export function sessionFile(root: string): string {
  return nodePath.join(statePath(root, "session.json"));
}
