import { promises as fs } from "node:fs";
import { spin } from "../report/spinner";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import { indexRepo, type RepoIndex } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles, fullSelection } from "../core/selector";
import { assessTask, runQuestions, compileTask, type EditScope } from "../core/clarify";
import { findMissingKeeps, type Instance } from "../core/understanding";
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
import { AGENT_CLIS, runAgent, continueAgent, type AgentCliDef } from "../claude/agentCli";
import { runValidators, type ValidationResult } from "../validate/validator";
import { renderFileDiff } from "../report/diff";
import { loadConfig, type GlintConfig } from "../util/config";
import { resolveAuth, type Auth } from "../util/globalConfig";
import { estimateTokens, formatTokens } from "../util/tokens";
import { openInEditor } from "../util/editor";
import { log } from "../util/logger";
import { printSelection, printManifestBox, printBand } from "./shared";

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
    if (cmd.type === "clear") {
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback, cursor home
      log.info(await renderHeader(VERSION, "session")); // follow-up context is kept
      input = await promptNextTask(false);
      continue; // skip the divider — keep the fresh screen clean
    }
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
  | { type: "clear" }
  | { type: "hint"; message: string };

/**
 * Interpret a line typed at the session prompt. Recognizes /commands and the
 * `glint <cmd>` forms (which people naturally type, having seen the header),
 * so they aren't mistaken for tasks. Everything else is a task.
 */
function interpret(input: string): SessionCommand {
  const raw = input.trim();
  const m = raw.match(/^(?:\/|glint\s+)(run|plan|switch|connect|search|help|clear|cls)\b\s*(.*)$/i);
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
  const alias =
    bare === "cd" || bare === "project" ? "search" : bare === "?" || bare === "commands" ? "help" : bare === "cls" ? "clear" : bare;
  const nav = navCommand(alias);
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
    case "clear":
    case "cls":
      return { type: "clear" };
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
  log.info(`  ${pc.cyan("/clear")}         clear the screen (keeps your context)`);
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
  const spinner = spin("Indexing repo…").start();
  const index = await indexRepo(root, config);

  let finalTask = task;
  let manifest: string;
  let repoTokens = 0;
  let editScope: EditScope | null = null; // occurrences the user authorized / told us to keep
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

    if (selection.primary.length + selection.supporting.length + selection.optional.length === 0) {
      if (repoTokens <= budget * 0.5) {
        selection = fullSelection(task, index, budget); // tiny project — send it all
      } else {
        log.warn("Nothing matched the task terms — try more specific words (component, page, or feature names).");
        process.exitCode = 1;
        return;
      }
    }

    // 3.5: understand & clarify before spending anything. Ranking says what's
    // relevant; this layer decides what's *safely resolvable* and sorts the
    // task into one of four bands (green/yellow/orange/red).
    const interactive = Boolean(process.stdin.isTTY) && !opts.yes && opts.ask !== false;
    const assessment = await assessTask(task, selection, root);
    printBand(assessment.band, assessment.reason);

    // Red: a destructive edit collides with identical targets in several
    // places. Never auto-apply it blind — if we can't ask (no TTY / --yes),
    // stop with the evidence instead of nuking every occurrence.
    if (assessment.band === "red" && !interactive) {
      log.warn(`Blocked: ${assessment.reason}.`);
      log.dim("Name the exact target or section in your task, or re-run interactively (without --yes) to choose.");
      process.exitCode = 1;
      return;
    }

    // Orange/Red (interactive): ask the focused question(s). Answers change the
    // targeting, so re-select. Yellow: no question — just tell the agent to
    // continue the existing design (doesn't change which files we pick).
    const asked =
      interactive && assessment.questions.length > 0
        ? await runQuestions(assessment.questions)
        : { refinements: [], scope: null };
    const answered = asked.refinements;
    editScope = asked.scope; // remembered so we can verify the agent honored it
    const refinements = assessment.styleNote ? [...answered, assessment.styleNote] : answered;
    if (refinements.length > 0) finalTask = compileTask(task, refinements);
    if (answered.length > 0) {
      const reSpin = spin("Re-targeting with clarified task…").start();
      selection = await selectFiles({ task: finalTask, root, index, graph, budget, seeds });
      reSpin.stop();
    }

    printSelection(selection);
    manifest = await generateManifest({ root, task: finalTask, selection, focus: opts.focus, sessionNote });
  }

  // 4: manifest + confirm (with view / edit before sending)
  let manifestTokens = estimateTokens(manifest);
  const target = auth.mode === "agent-cli" ? AGENT_CLIS[auth.agent].title : model;
  printManifestBox({
    tokens: manifestTokens,
    budget,
    target,
    detail: `via ${auth.source}`,
  });

  if (!opts.yes) {
    for (;;) {
      const { action } = await prompts({
        type: "select",
        name: "action",
        message: `Send to ${target}?`,
        choices: [
          { title: "Send", value: "send" },
          { title: "View manifest", description: "see exactly what will be sent", value: "view" },
          { title: "Edit manifest", description: "open in your editor and tweak the context", value: "edit" },
          { title: "Cancel", value: "cancel" },
        ],
        initial: 0,
      });
      if (action === undefined || action === "cancel") {
        log.info("Aborted — nothing was sent.");
        return;
      }
      if (action === "view") {
        log.info("");
        log.info(pc.dim("─".repeat(68)));
        log.info(manifest);
        log.info(pc.dim("─".repeat(68)));
        log.info("");
        continue;
      }
      if (action === "edit") {
        try {
          const edited = await openInEditor(manifest, "md");
          if (edited.trim() && edited !== manifest) {
            manifest = edited;
            manifestTokens = estimateTokens(manifest);
            log.success(`Manifest updated — now ~${formatTokens(manifestTokens)} tokens`);
          } else {
            log.dim("No changes.");
          }
        } catch {
          log.warn("Couldn't open an editor. Set $EDITOR (e.g. `export EDITOR=nano`) and retry, or Send as-is.");
        }
        continue;
      }
      break; // send
    }
  }

  const outcome =
    auth.mode === "agent-cli"
      ? await runViaAgentCli(root, manifest, opts, AGENT_CLIS[auth.agent], index, config)
      : await runViaApi(root, manifest, model, auth, index, opts);

  // Post-edit scope enforcement. You told us which occurrence to change and
  // which identical copies to leave alone — trust the agent, but verify. An
  // agent can still find-and-replace its way through a copy it was told to
  // keep, and that's exactly the failure the clarification exists to prevent.
  if (outcome && editScope) {
    const missing = await findMissingKeeps(root, editScope.keep);
    if (missing.length > 0) printScopeViolation(editScope, missing);
  }

  if (outcome) {
    if (!scaffold && repoTokens > 0) printSavings(manifestTokens, repoTokens);
    ctx.memory = { task: finalTask, touched: outcome.touched, summary: outcome.summary.slice(0, 400) };
  }
}

/** The agent edited past what the user authorized — say so loudly. */
function printScopeViolation(scope: EditScope, missing: Instance[]): void {
  log.info("");
  log.warn(
    `Scope violation — ${missing.length} occurrence${missing.length === 1 ? "" : "s"} you asked to keep ${
      missing.length === 1 ? "was" : "were"
    } also changed:`,
  );
  for (const m of missing) {
    const where = m.landmark ? ` inside <${m.landmark}>` : "";
    log.warn(`  • "${scope.phrase}"${where} (${m.file} line ${m.line}) is no longer there`);
  }
  log.dim("The agent went beyond what you authorized. Undo everything with `glint revert`, then retry naming the target explicitly.");
  process.exitCode = 1;
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
  const work = spin("Claude is working…").start();
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
      const rSpin = spin(`Repair attempt ${attempt + 1}/${MAX_REPAIRS}…`).start();
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
  index: RepoIndex,
  config: GlintConfig,
): Promise<RunOutcome | null> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  // Snapshot file contents up front so we can diff (and revert) without git.
  const snapshot = await snapshotContents(root, index);

  log.info("");
  log.info(pc.dim(`── ${agent.title} is working — its live output follows ` + "─".repeat(Math.max(0, 30 - agent.title.length))));
  try {
    await runAgent(
      agent,
      root,
      `${manifest}\n\nImplement the task now, exactly as described under "How to apply this task" — smallest change that literally satisfies it, nothing extra.`,
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }

  let validationFailed = false;
  if (opts.validate !== false) {
    for (let attempt = 0; ; attempt++) {
      const results = await validate(root);
      if (results === null) break;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) break;
      if (attempt >= MAX_REPAIRS) {
        validationFailed = true;
        log.error(`Validation still failing after ${MAX_REPAIRS} repair attempts — review the diff below.`);
        break;
      }
      log.info(pc.dim(`── repair attempt ${attempt + 1}/${MAX_REPAIRS} ──`));
      try {
        await continueAgent(agent, root, repairPrompt(failed));
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        validationFailed = true;
        break;
      }
    }
  }

  // Detect what changed by comparing the tree against the pre-run snapshot.
  const changes = await backupAndDiff(root, config, snapshot, runId);
  if (changes.length === 0) {
    log.info("");
    log.info(`${agent.title} made no tracked edits.`);
    return { touched: [], summary: "" };
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  log.info("");
  log.info(pc.bold("Changes:"));
  for (const c of changes) {
    const d = renderFileDiff(c.path, c.before, c.after, c.created);
    totalAdded += d.added;
    totalRemoved += d.removed;
    printFileDiff(c.path, c.created, d.added, d.removed, d.rendered);
  }

  log.info("");
  log.info(`${changes.length} file(s) changed, ${pc.green(`+${totalAdded}`)} ${pc.red(`−${totalRemoved}`)}`);
  log.info("");
  log.dim(`Billing: ${agent.billingNote}.`);
  log.dim("Undo anytime with `glint revert`.");

  if (validationFailed) process.exitCode = 1;
  return { touched: changes.map((c) => c.path), summary: "" };
}

interface FileChange {
  path: string;
  before: string;
  after: string;
  created: boolean;
}

/** Read current contents of every indexed file — the baseline for git-free change tracking. */
async function snapshotContents(root: string, index: RepoIndex): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const f of index.files) {
    const content = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => null);
    if (content !== null) snap.set(f.path, content);
  }
  return snap;
}

/**
 * Compare the tree against the snapshot, back up modified originals to
 * .glint/backup/<runId>/ (so `glint revert` works), and return the diffs.
 */
async function backupAndDiff(
  root: string,
  config: GlintConfig,
  snapshot: Map<string, string>,
  runId: string,
): Promise<FileChange[]> {
  const after = await indexRepo(root, config); // re-scan to pick up newly created files
  const backupFilesDir = nodePath.join(root, ".glint", "backup", runId, "files");
  const created: string[] = [];
  const changes: FileChange[] = [];

  for (const f of after.files) {
    const afterContent = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => null);
    if (afterContent === null) continue;
    const before = snapshot.get(f.path);
    if (before === undefined) {
      created.push(f.path);
      changes.push({ path: f.path, before: "", after: afterContent, created: true });
    } else if (before !== afterContent) {
      const backupPath = nodePath.join(backupFilesDir, f.path);
      await fs.mkdir(nodePath.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, before);
      changes.push({ path: f.path, before, after: afterContent, created: false });
    }
  }

  if (created.length > 0) {
    await fs.mkdir(nodePath.join(root, ".glint", "backup", runId), { recursive: true });
    await fs.writeFile(
      nodePath.join(root, ".glint", "backup", runId, "created.json"),
      JSON.stringify(created, null, 2),
    );
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Runs validators with a spinner. Returns null when the repo has none configured. */
async function validate(root: string): Promise<ValidationResult[] | null> {
  const spinner = spin("Validating…").start();
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
