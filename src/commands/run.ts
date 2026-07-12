import { promises as fs } from "node:fs";
import nodePath from "node:path";
import ora from "ora";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import { indexRepo, type RepoIndex } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles, fullSelection } from "../core/selector";
import { askClarifications, compileTask } from "../core/clarify";
import { generateManifest, generateScaffoldManifest } from "../core/manifest";
import { seedsFrom, buildSessionNote, type SessionMemory } from "../core/session";
import { renderBox, darkGreen } from "../report/box";
import { renderHeader } from "../report/banner";
import { VERSION } from "../version";
import { switchCommand } from "./switch";
import { connectCommand } from "./connect";
import { planCommand } from "./plan";
import { pickProject, homeRelative } from "./search";
import { EditStage } from "../claude/tools";
import { ClaudeRunner, type RunnerUsage } from "../claude/runner";
import {
  AGENT_CLIS,
  runAgent,
  continueAgent,
  isGitRepo,
  hasHeadCommit,
  gitInit,
  gitBaselineCommit,
  gitDirtyFiles,
  gitBefore,
  type AgentCliDef,
} from "../claude/agentCli";
import { runValidators, type ValidationResult } from "../validate/validator";
import { renderFileDiff } from "../report/diff";
import { loadConfig, type GlintConfig } from "../util/config";
import { resolveAuth, type Auth } from "../util/globalConfig";
import { estimateTokens, formatTokens } from "../util/tokens";
import { log } from "../util/logger";
import { printSelection, printManifestBox } from "./shared";

const MAX_REPAIRS = 2;

interface RunOptions {
  budget?: string;
  model?: string;
  yes?: boolean;
  validate?: boolean;
  focus?: boolean;
  ask?: boolean;
}

interface ExecContext {
  root: string;
  auth: Auth;
  config: GlintConfig;
  budget: number;
  model: string;
  opts: RunOptions;
  memory?: SessionMemory; // previous task in this session — fuels follow-up mode
}

interface RunOutcome {
  touched: string[];
  summary: string;
}

export async function runCommand(taskArg: string | undefined, opts: RunOptions): Promise<void> {
  const root = process.cwd();

  // Preflight: fail in the first second, not after indexing
  const auth = await resolveAuth();
  if (!auth) {
    log.error("Not connected to an AI provider.");
    log.info("Run `glint connect` for one-time setup — API key, browser login, Claude Code, Cursor, or ChatGPT.");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const ctx: ExecContext = {
    root,
    auth,
    config,
    opts,
    budget: opts.budget ? Number(opts.budget) : config.budgetTokens,
    model: opts.model ?? config.model,
  };

  // Scripts/CI (--yes or piped input) stay single-shot; interactive terminals
  // get a persistent session that keeps taking tasks until /exit
  const sessionMode = Boolean(process.stdin.isTTY) && opts.yes !== true;
  if (!sessionMode) {
    if (!taskArg) {
      log.error('No task given. Usage: glint run "add a checkout form"');
      process.exitCode = 1;
      return;
    }
    await executeTask(taskArg, ctx);
    return;
  }

  log.info(await renderHeader(VERSION, "session"));
  log.dim("  Type a task, or a /command. /help lists them.");
  log.info("");

  let input = taskArg ?? (await promptNextTask(true));
  let count = 0;
  while (input) {
    const cmd = interpret(input);
    if (cmd.type === "switch" || cmd.type === "connect") {
      cmd.type === "switch" ? await switchCommand() : await connectCommand();
      const refreshed = await resolveAuth(); // pick up the newly chosen agent
      if (refreshed) ctx.auth = refreshed;
    } else if (cmd.type === "search") {
      const picked = await pickProject();
      if (picked) await retargetRoot(ctx, picked);
    } else if (cmd.type === "help") {
      printSessionHelp();
    } else if (cmd.type === "hint") {
      log.info(cmd.message);
    } else if (cmd.type === "plan") {
      try {
        await planCommand(cmd.task, { budget: ctx.opts.budget, focus: ctx.opts.focus });
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
      }
    } else {
      count++;
      try {
        await executeTask(cmd.task, ctx);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
      }
    }
    log.info("");
    log.info(pc.dim("─".repeat(68)));
    input = await promptNextTask(false);
  }
  log.info(pc.dim(`Session closed — ${count} task(s) run.`));
}

type SessionCommand =
  | { type: "task"; task: string }
  | { type: "plan"; task: string }
  | { type: "switch" }
  | { type: "connect" }
  | { type: "search" }
  | { type: "help" }
  | { type: "hint"; message: string };

/**
 * Interpret a line typed at the session prompt. Recognizes /commands and the
 * `glint <cmd>` forms (which people naturally type, having seen the header),
 * so they aren't mistaken for tasks. Everything else is a task.
 */
function interpret(input: string): SessionCommand {
  const raw = input.trim();
  const m = raw.match(/^(?:\/|glint\s+)(run|plan|switch|connect|search|help)\b\s*(.*)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const rest = m[2].trim();
    const nav = navCommand(name);
    if (nav) return nav;
    if (name === "plan") {
      return rest
        ? { type: "plan", task: rest }
        : { type: "hint", message: `${pc.cyan("/plan")} needs a task — e.g. ${pc.bold('/plan add a login form')}` };
    }
    // "run"
    return rest
      ? { type: "task", task: rest }
      : { type: "hint", message: "Just type your task directly — e.g. " + pc.bold('"add a checkout form"') };
  }
  // bare no-arg command words
  const bare = raw.toLowerCase();
  const nav = navCommand(bare === "cd" || bare === "project" ? "search" : bare === "?" || bare === "commands" ? "help" : bare);
  if (nav) return nav;
  return { type: "task", task: raw };
}

function navCommand(name: string): SessionCommand | null {
  switch (name) {
    case "switch":
      return { type: "switch" };
    case "connect":
      return { type: "connect" };
    case "search":
      return { type: "search" };
    case "help":
      return { type: "help" };
    default:
      return null;
  }
}

/** Point the session at a different project mid-session. Reloads config, drops follow-up memory. */
async function retargetRoot(ctx: ExecContext, newRoot: string): Promise<void> {
  process.chdir(newRoot);
  ctx.root = newRoot;
  ctx.config = await loadConfig(newRoot);
  ctx.budget = ctx.opts.budget ? Number(ctx.opts.budget) : ctx.config.budgetTokens;
  ctx.model = ctx.opts.model ?? ctx.config.model;
  ctx.memory = undefined; // follow-up context is project-specific
  log.success(`Now working in ${pc.bold(homeRelative(newRoot))}`);
}

function printSessionHelp(): void {
  log.info("");
  log.info(pc.bold("In-session commands:"));
  log.info(`  ${pc.cyan("/plan <task>")}   preview what would be sent, without sending`);
  log.info(`  ${pc.cyan("/switch")}        change coding agent (Claude Code / Cursor / ChatGPT / API)`);
  log.info(`  ${pc.cyan("/search")}        switch to a different project folder`);
  log.info(`  ${pc.cyan("/connect")}       set up or re-authenticate a provider`);
  log.info(`  ${pc.cyan("/help")}          show this list`);
  log.info(`  ${pc.cyan("/exit")}          end the session`);
  log.info(pc.dim("  Anything else is treated as a task to run."));
}

async function promptNextTask(first: boolean): Promise<string | undefined> {
  for (;;) {
    const { next } = await prompts({
      type: "text",
      name: "next",
      message: first ? "What should I do?" : "Next task",
    });
    if (next === undefined) return undefined; // Ctrl-C
    const task = String(next).trim();
    if (["/exit", "/quit", "/q", "exit", "quit"].includes(task.toLowerCase())) return undefined;
    if (task) return task;
    log.dim("Enter a task, or /exit to quit.");
  }
}

async function executeTask(task: string, ctx: ExecContext): Promise<void> {
  const { root, auth, config, budget, model, opts } = ctx;
  const sessionNote = buildSessionNote(ctx.memory);

  // 1-3: index, map, select
  const spinner = ora("Indexing repo…").start();
  const index = await indexRepo(root, config);

  let finalTask = task;
  let manifest: string;
  let repoTokens = 0;
  const scaffold = index.files.length === 0;

  if (scaffold) {
    // Greenfield: nothing to compress — thin manifest, agent builds from
    // scratch. From the next task on, the created files become the index and
    // normal precision selection kicks in automatically.
    spinner.stop();
    log.info("");
    for (const line of renderBox("New project — scaffold mode", [
      { left: "No source files yet; the agent will build from scratch", kind: "main" },
      { left: "seatbelts stay on: git baseline, validation, diff, revert", kind: "sub" },
    ])) {
      log.info(line);
    }
    log.info("");
    manifest = await generateScaffoldManifest({ root, task, sessionNote });
  } else {
    spinner.text = "Mapping imports…";
    const graph = await buildGraph(root, index);
    spinner.text = "Selecting files…";
    const seeds = seedsFrom(task, ctx.memory);
    let selection = await selectFiles({ task, root, index, graph, budget, seeds });
    spinner.stop();
    repoTokens = estimateTokens(index.files.reduce((sum, f) => sum + f.size, 0));

    if (selection.primary.length === 0) {
      if (repoTokens <= budget * 0.5) {
        selection = fullSelection(task, index, budget); // tiny project — send it all
      } else {
        log.warn("Nothing matched the task terms — try more specific words (component, page, or feature names).");
        process.exitCode = 1;
        return;
      }
    }

    // 3.5: clarify ambiguity before spending anything — every answer is
    // compiled back into the task, then selection re-runs with the sharper ask
    const interactive = Boolean(process.stdin.isTTY) && !opts.yes && opts.ask !== false;
    if (interactive) {
      const refinements = await askClarifications(task, selection, root);
      if (refinements.length > 0) {
        finalTask = compileTask(task, refinements);
        const reSpin = ora("Re-targeting with clarified task…").start();
        selection = await selectFiles({ task: finalTask, root, index, graph, budget, seeds });
        reSpin.stop();
      }
    }

    printSelection(selection);
    manifest = await generateManifest({ root, task: finalTask, selection, focus: opts.focus, sessionNote });
  }

  // 4: manifest + confirm
  const manifestTokens = estimateTokens(manifest);
  const target = auth.mode === "agent-cli" ? AGENT_CLIS[auth.agent].title : model;
  printManifestBox({
    tokens: manifestTokens,
    budget,
    target,
    detail: `via ${auth.source}`,
  });

  if (!opts.yes) {
    const { go } = await prompts({ type: "confirm", name: "go", message: "Send to Claude?", initial: true });
    if (!go) {
      log.info("Aborted — nothing was sent.");
      return;
    }
  }

  const outcome =
    auth.mode === "agent-cli"
      ? await runViaAgentCli(root, manifest, opts, AGENT_CLIS[auth.agent])
      : await runViaApi(root, manifest, model, auth, index, opts);

  if (outcome) {
    if (!scaffold && repoTokens > 0) printSavings(manifestTokens, repoTokens);
    ctx.memory = { task: finalTask, touched: outcome.touched, summary: outcome.summary.slice(0, 400) };
  }
}

/** The product's pitch, printed after every run: what was sent vs what exists. */
function printSavings(sentTokens: number, repoTokens: number): void {
  // Rough model of what an agent's own discovery loop would have read:
  // a quarter of the repo, floored at 30k, capped at 250k tokens.
  const exploration = Math.min(Math.max(repoTokens * 0.25, 30_000), 250_000);
  const saved = Math.round(Math.max(0, exploration - sentTokens));
  const pctNum = Math.min(100, (sentTokens / repoTokens) * 100);
  const pct = pctNum < 1 ? pctNum.toFixed(1) : String(Math.round(pctNum));
  log.info("");
  log.info(
    darkGreen(`Context sent: ~${formatTokens(sentTokens)} of ~${formatTokens(repoTokens)} repo tokens (${pct}%)`) +
      (saved > 0 ? pc.dim(`  — est. ~${formatTokens(saved)} tokens saved vs unassisted exploration`) : ""),
  );
}

// ---------------------------------------------------------------------------
// Provider: Anthropic API (built-in edit loop, staged edits, glint revert)
// ---------------------------------------------------------------------------

async function runViaApi(
  root: string,
  manifest: string,
  model: string,
  auth: Auth,
  index: RepoIndex,
  opts: RunOptions,
): Promise<RunOutcome | null> {
  const stage = new EditStage(root);
  const work = ora("Claude is working…").start();
  const runner = new ClaudeRunner({
    model,
    stage,
    index,
    apiKey: auth.mode === "api-key" ? auth.apiKey : undefined,
    onProgress: (text) => {
      work.text = `Claude: ${text}`;
    },
  });

  let summary: string;
  try {
    summary = await runner.run(manifest);
  } catch (err) {
    work.fail(err instanceof Error ? err.message : String(err));
    hintAuth(err);
    process.exitCode = 1;
    return null;
  }
  work.succeed("Claude finished");

  if (stage.touched.length === 0) {
    log.info("");
    log.info(summary || "Claude made no edits.");
    return { touched: [], summary };
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  await stage.apply(runId);
  const backupFilesDir = nodePath.join(root, ".glint", "backup", runId, "files");

  let validationFailed = false;
  if (opts.validate !== false) {
    for (let attempt = 0; ; attempt++) {
      const results = await validate(root);
      if (results === null) break;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) break;
      if (attempt >= MAX_REPAIRS) {
        validationFailed = true;
        log.error(
          `Validation still failing after ${MAX_REPAIRS} repair attempts. Edits are kept — review the diff, fix manually, or run \`glint revert\`.`,
        );
        break;
      }
      const rSpin = ora(`Repair attempt ${attempt + 1}/${MAX_REPAIRS}…`).start();
      try {
        summary = await runner.continueWith(repairPrompt(failed));
      } catch (err) {
        rSpin.fail(err instanceof Error ? err.message : String(err));
        validationFailed = true;
        break;
      }
      rSpin.succeed(`Repair attempt ${attempt + 1} applied`);
      await stage.apply(runId);
    }
  }

  // report
  let totalAdded = 0;
  let totalRemoved = 0;
  log.info("");
  log.info(pc.bold("Changes:"));
  for (const rel of stage.allTouched.sort()) {
    const after = await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "");
    const created = stage.wasCreated(rel);
    const before = created ? "" : await fs.readFile(nodePath.join(backupFilesDir, rel), "utf8").catch(() => "");
    const d = renderFileDiff(rel, before, after, created);
    totalAdded += d.added;
    totalRemoved += d.removed;
    printFileDiff(rel, created, d.added, d.removed, d.rendered);
  }

  log.info("");
  log.info(`${stage.allTouched.length} file(s) changed, ${pc.green(`+${totalAdded}`)} ${pc.red(`−${totalRemoved}`)}`);
  if (summary) {
    log.info("");
    log.info(summary);
  }
  log.info("");
  const u = runner.usage;
  log.dim(
    `Tokens: ${formatTokens(u.input)} in + ${formatTokens(u.cacheRead)} cached / ${formatTokens(u.output)} out${costNote(model, u)}`,
  );
  log.dim("Undo anytime with `glint revert`.");

  if (validationFailed) process.exitCode = 1;
  return { touched: stage.allTouched, summary };
}

// ---------------------------------------------------------------------------
// Provider: agent CLI passthrough — Claude Code / Cursor / Codex bring their
// own auth and edit loop; glint tracks and undoes changes via git
// ---------------------------------------------------------------------------

async function runViaAgentCli(
  root: string,
  manifest: string,
  opts: RunOptions,
  agent: AgentCliDef,
): Promise<RunOutcome | null> {
  if (!(await ensureGitBaseline(root, opts))) {
    process.exitCode = 1;
    return null;
  }

  const dirtyBefore = await gitDirtyFiles(root);
  if (dirtyBefore.size > 0) {
    log.warn(`${dirtyBefore.size} file(s) already have uncommitted changes — glint will only report files touched by this run.`);
  }

  const work = ora(`${agent.title} is working… (this can take a few minutes)`).start();
  let summary: string;
  try {
    summary = await runAgent(agent, root, `${manifest}\n\nImplement the task now with the smallest correct change set.`);
  } catch (err) {
    work.fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
  work.succeed(`${agent.title} finished`);

  let validationFailed = false;
  if (opts.validate !== false) {
    for (let attempt = 0; ; attempt++) {
      const results = await validate(root);
      if (results === null) break;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) break;
      if (attempt >= MAX_REPAIRS) {
        validationFailed = true;
        log.error(`Validation still failing after ${MAX_REPAIRS} repair attempts — review with git diff.`);
        break;
      }
      const rSpin = ora(`Repair attempt ${attempt + 1}/${MAX_REPAIRS}…`).start();
      try {
        summary = await continueAgent(agent, root, repairPrompt(failed));
      } catch (err) {
        rSpin.fail(err instanceof Error ? err.message : String(err));
        validationFailed = true;
        break;
      }
      rSpin.succeed(`Repair attempt ${attempt + 1} applied`);
    }
  }

  const dirtyAfter = await gitDirtyFiles(root);
  const touched = [...dirtyAfter].filter((p) => !dirtyBefore.has(p)).sort();

  if (touched.length === 0) {
    log.info("");
    log.info(summary || `${agent.title} made no edits.`);
    return { touched: [], summary };
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  log.info("");
  log.info(pc.bold("Changes:"));
  for (const rel of touched) {
    const after = await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "");
    const before = await gitBefore(root, rel);
    const d = renderFileDiff(rel, before ?? "", after, before === null);
    totalAdded += d.added;
    totalRemoved += d.removed;
    printFileDiff(rel, before === null, d.added, d.removed, d.rendered);
  }

  log.info("");
  log.info(`${touched.length} file(s) changed, ${pc.green(`+${totalAdded}`)} ${pc.red(`−${totalRemoved}`)}`);
  if (summary) {
    log.info("");
    log.info(summary);
  }
  log.info("");
  log.dim(`Billing: ${agent.billingNote}.`);
  log.dim("Undo with git: `git checkout -- <file>` for edits, `git clean -f <file>` for new files.");

  if (validationFailed) process.exitCode = 1;
  return { touched, summary };
}

/**
 * Agent-CLI providers track and undo edits through git. If the folder
 * isn't a repo yet (common for quick HTML/CSS projects), offer to set one up
 * instead of erroring out.
 */
async function ensureGitBaseline(root: string, opts: RunOptions): Promise<boolean> {
  if (await isGitRepo(root)) {
    if (!(await hasHeadCommit(root))) {
      await writeDefaultGitignore(root);
      await gitBaselineCommit(root);
      log.success("Committed a baseline snapshot (the repo had no commits yet).");
    }
    return true;
  }

  log.warn("This folder isn't a git repository. Glint uses git to track and undo the agent's edits.");
  let go = opts.yes === true;
  if (!go) {
    const answer = await prompts({
      type: "confirm",
      name: "go",
      message: "Initialize git here now? (git init + baseline commit — nothing leaves your machine)",
      initial: true,
    });
    go = answer.go === true;
  }
  if (!go) {
    log.info("Aborted. Run `git init` yourself, or connect with an API key instead (`glint connect`).");
    return false;
  }

  await gitInit(root);
  await writeDefaultGitignore(root);
  await gitBaselineCommit(root);
  log.success("Initialized git and committed a baseline snapshot.");
  return true;
}

/** Keep the baseline commit from swallowing junk when the project has no .gitignore. */
async function writeDefaultGitignore(root: string): Promise<void> {
  const file = nodePath.join(root, ".gitignore");
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "node_modules/\ndist/\nbuild/\n.glint/\n*.log\n");
    log.dim("Created a default .gitignore (node_modules, dist, .glint).");
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Runs validators with a spinner. Returns null when the repo has none configured. */
async function validate(root: string): Promise<ValidationResult[] | null> {
  const spinner = ora("Validating…").start();
  const results = await runValidators(root);
  spinner.stop();
  if (results.length === 0) {
    log.dim("No validators detected (tsc / eslint / test) — skipping validation.");
    return null;
  }
  for (const r of results) {
    r.ok ? log.success(`${r.name} passed`) : log.error(`${r.name} failed`);
  }
  return results;
}

function repairPrompt(failed: ValidationResult[]): string {
  const feedback = failed.map((f) => `${f.name} failed:\n${f.output}`).join("\n\n");
  return `Local validation failed after applying your edits.\n\n${feedback}\n\nFix exactly these issues.`;
}

function printFileDiff(rel: string, created: boolean, added: number, removed: number, rendered: string): void {
  log.info("");
  log.info(
    `${created ? pc.green("A") : pc.yellow("M")} ${pc.bold(rel)}  ${pc.green(`+${added}`)} ${pc.red(`−${removed}`)}`,
  );
  if (rendered) log.info(rendered);
}

const PRICES: [RegExp, [number, number]][] = [
  [/fable-5|mythos/, [10, 50]],
  [/opus/, [5, 25]],
  [/sonnet/, [3, 15]],
  [/haiku/, [1, 5]],
];

function costNote(model: string, u: RunnerUsage): string {
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  if (!price) return "";
  const usd = (u.input * price[0] + u.cacheRead * price[0] * 0.1 + u.output * price[1]) / 1e6;
  return `  (~$${usd.toFixed(2)})`;
}

function hintAuth(err: unknown): void {
  const msg = err instanceof Error ? err.message : "";
  if (err instanceof Anthropic.AuthenticationError || msg.includes("authentication method")) {
    log.info("Credentials were rejected or missing. Run `glint connect` to (re)connect.");
  }
}
