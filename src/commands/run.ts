import { promises as fs } from "node:fs";
import { spin, pixelWave } from "../report/spinner";
import { readSessionLine, type SlashCommand } from "../report/sessionInput";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import { indexRepo, type RepoIndex } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles, fullSelection } from "../core/selector";
import { assessTask, runQuestions, compileTask, type EditScope } from "../core/clarify";
import { findMissingKeeps, type Instance } from "../core/understanding";
import { rememberChoice } from "../core/memory";
import { repoFileNames, forgetFileNames } from "../core/mentions";
import { surgicalRevert } from "../core/surgicalRevert";
import { loadRules, extractProtectedPaths, protectedMatch } from "../core/rules";
import { isModifyAction, targetDescriptors, findMissingTargets } from "../core/preflight";
import { generateManifest, generateScaffoldManifest } from "../core/manifest";
import { seedsFrom, buildSessionNote, type SessionMemory } from "../core/session";
import { renderBox, darkGreen } from "../report/box";
import { renderHeader } from "../report/banner";
import { VERSION } from "../version";
import { switchCommand } from "./switch";
import { connectCommand } from "./connect";
import { planCommand } from "./plan";
import { flowCommand } from "./flow";
import { compareCommand } from "./compare";
import { pickProject, homeRelative } from "./search";
import { EditStage } from "../claude/tools";
import { ClaudeRunner, type RunnerUsage } from "../claude/runner";
import { AGENT_CLIS, runAgent, continueAgent, type AgentCliDef, type AgentUsage } from "../claude/agentCli";
import { runValidators, type ValidationResult } from "../validate/validator";
import { renderFileDiff } from "../report/diff";
import { loadConfig, type ProjectConfig } from "../util/config";
import { resolveAuth, type Auth } from "../util/globalConfig";
import { estimateTokens } from "../util/tokens";
import { openInEditor } from "../util/editor";
import { log } from "../util/logger";
import { track, firstRunNotice } from "../util/telemetry";
import { printSelection, printBand, printSemanticSummary } from "./shared";
import { stateDir } from "../util/paths";

const MAX_REPAIRS = 2;

interface RunOptions {
  budget?: string;
  model?: string;
  yes?: boolean;
  validate?: boolean;
  focus?: boolean;
  ask?: boolean;
  surgical?: boolean; // experimental: restrict the agent to a direct edit, no exploration
}

interface ExecContext {
  root: string;
  auth: Auth;
  config: ProjectConfig;
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
    log.info("Run `super-t connect` for one-time setup — API key, browser login, Claude Code, Cursor, or ChatGPT.");
    await track("error", null, { code: "no_auth" }); // the classic drop-off point
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
      log.error('No task given. Usage: super-t run "add a checkout form"');
      process.exitCode = 1;
      return;
    }
    await executeTask(taskArg, ctx);
    return;
  }

  log.info(await renderHeader(VERSION, "session"));
  const notice = await firstRunNotice();
  if (notice) {
    for (const line of notice.split("\n")) log.dim(`  ${line}`);
    log.info("");
  }
  log.dim("  Type a task — / for commands · Esc to exit.");
  log.info("");

  let input = taskArg ?? (await promptNextTask(true));
  let count = 0;
  while (input) {
    let cmd = interpret(input);
    if (cmd.type === "menu") cmd = await showCommandMenu(); // "/" → pick a command
    if (cmd.type === "exit") break;
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
      if (cmd.message) log.info(cmd.message); // empty = cancelled menu → no-op
    } else if (cmd.type === "plan") {
      try {
        await planCommand(cmd.task, { budget: ctx.opts.budget, focus: ctx.opts.focus });
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
      }
    } else if (cmd.type === "flow") {
      try {
        await flowCommand(cmd.steps, { budget: ctx.opts.budget });
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
      }
    } else if (cmd.type === "compare") {
      try {
        await compareCommand(cmd.task, { budget: ctx.opts.budget });
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
      }
    } else if (cmd.type === "task") {
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
  | { type: "flow"; steps: string }
  | { type: "compare"; task: string }
  | { type: "switch" }
  | { type: "connect" }
  | { type: "search" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "menu" } // bare "/" or an unknown /command → show the command picker
  | { type: "exit" }
  | { type: "hint"; message: string };

/**
 * Interpret a line typed at the session prompt. Recognizes /commands and the
 * `super-t <cmd>` forms (which people naturally type, having seen the header),
 * so they aren't mistaken for tasks. Everything else is a task.
 */
export function interpret(input: string): SessionCommand {
  const raw = input.trim();
  const m = raw.match(/^(?:\/|super-t\s+)(run|plan|flow|compare|switch|connect|search|help|clear|cls)\b\s*(.*)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    // People naturally type `super-t flow "…"` inside the session — drop the
    // quotes so they don't leak into the first and last step.
    const rest = m[2].trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
    const nav = navCommand(name);
    if (nav) return nav;
    if (name === "flow") {
      return rest
        ? { type: "flow", steps: rest }
        : { type: "hint", message: `${pc.cyan("/flow")} needs steps — e.g. ${pc.bold('/flow audit auth with claude, then fix it with cursor')}` };
    }
    if (name === "compare") {
      return rest
        ? { type: "compare", task: rest }
        : { type: "hint", message: `${pc.cyan("/compare")} needs a task — e.g. ${pc.bold('/compare add rate limiting')}` };
    }
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
  // A lone "/" or an unrecognized /command opens the picker rather than running
  // as a task — so "/" is all you type to see and choose every command.
  if (raw.startsWith("/")) return { type: "menu" };
  return { type: "task", task: raw };
}

// Session commands, in menu order. `arg` marks ones that need a follow-up (task).
const MENU: SlashCommand[] = [
  { value: "plan", title: "/plan", description: "preview a task — don't send it", arg: true },
  { value: "flow", title: "/flow", description: "multi-step task across agents", arg: true },
  { value: "compare", title: "/compare", description: "same task through every agent", arg: true },
  { value: "switch", title: "/switch", description: "change the coding agent" },
  { value: "search", title: "/search", description: "switch to another project" },
  { value: "connect", title: "/connect", description: "set up or re-authenticate a provider" },
  { value: "clear", title: "/clear", description: "clear the screen (keeps context)" },
  { value: "help", title: "/help", description: "show all commands" },
  { value: "exit", title: "/exit", description: "end the session" },
];

/** Show the command picker (triggered by typing "/") and resolve the choice. */
async function showCommandMenu(): Promise<SessionCommand> {
  const { cmd } = await prompts({
    type: "select",
    name: "cmd",
    message: "Commands",
    choices: MENU.map((c) => ({ title: c.title, description: c.description, value: c.value })),
    hint: "↑↓ to move · enter to pick · esc to cancel",
  });
  if (cmd === undefined) return { type: "hint", message: "" }; // cancelled — back to the prompt
  const entry = MENU.find((m) => m.value === cmd);
  if (entry?.arg) {
    const label = cmd === "flow" ? "Steps" : "Task";
    const { arg } = await prompts({ type: "text", name: "arg", message: label });
    const a = arg ? String(arg).trim() : "";
    if (!a) return { type: "hint", message: "" };
    if (cmd === "flow") return { type: "flow", steps: a };
    if (cmd === "compare") return { type: "compare", task: a };
    return { type: "plan", task: a };
  }
  return { type: cmd } as SessionCommand;
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
  forgetFileNames(newRoot); // re-scan filenames for the new project
  log.success(`Now working in ${pc.bold(homeRelative(newRoot))}`);
}

function printSessionHelp(): void {
  log.info("");
  log.info(pc.bold("In-session commands:"));
  log.info(`  ${pc.cyan("/plan <task>")}   preview what would be sent, without sending`);
  log.info(`  ${pc.cyan("/flow")}          <steps>  multi-step task routed across agents`);
  log.info(`  ${pc.cyan("/compare")}       <task>   run the same task through every agent`);
  log.info(`  ${pc.cyan("/switch")}        change coding agent (Claude Code / Cursor / ChatGPT / API)`);
  log.info(`  ${pc.cyan("/search")}        switch to a different project folder`);
  log.info(`  ${pc.cyan("/connect")}       set up or re-authenticate a provider`);
  log.info(`  ${pc.cyan("/clear")}         clear the screen (keeps your context)`);
  log.info(`  ${pc.cyan("/help")}          show this list`);
  log.info(`  ${pc.cyan("/exit")}          end the session`);
  log.info(pc.dim("  Anything else is treated as a task to run."));
}

async function promptNextTask(first: boolean): Promise<string | undefined> {
  // Filenames you type get tinted if they exist, so you can see Super Terminal found
  // them before submitting. Cached per repo — a glob per keystroke would crawl.
  const known = await repoFileNames(process.cwd()).catch(() => new Set<string>());
  const isFile = (t: string): boolean => known.has(t) || known.has(nodePath.basename(t));
  for (;;) {
    // Type freely for a task; typing "/" pops the command dropdown instantly.
    const next = await readSessionLine(first ? "What should I do?" : "Next task", MENU, isFile);
    if (next === undefined) return undefined; // Ctrl-C
    const task = next.trim();
    if (["/exit", "/quit", "/q", "exit", "quit"].includes(task.toLowerCase())) return undefined;
    if (task) return task;
    log.dim("Enter a task, or / to pick a command.");
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

    // Preflight: a modify/destructive edit needs an existing target. If every
    // specific thing the task names is absent from the whole repo, don't spend
    // tokens letting the agent rediscover that — this is the token USP.
    if (isModifyAction(assessment.frame.action)) {
      const named = targetDescriptors(task);
      const missing = named.length > 0 ? await findMissingTargets(root, index.files, named) : [];
      if (missing && named.length > 0 && missing.length === named.length) {
        log.info("");
        log.warn(`Couldn't find ${missing.map((m) => `“${m}”`).join(" or ")} anywhere in the codebase.`);
        log.dim(
          `A ${assessment.frame.action} needs an existing target — sending this would just spend tokens for the agent to find the same. Check the name, or that you're in the right project.`,
        );
        if (!interactive) {
          process.exitCode = 1;
          return;
        }
        const ans = await prompts({ type: "confirm", name: "send", message: "Send to the agent anyway?", initial: false });
        if (!ans.send) {
          log.info("Cancelled — no tokens spent.");
          return;
        }
      }
    }

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
    if (assessment.recallNote) log.dim(`  ↳ ${assessment.recallNote}`);
    const asked =
      interactive && assessment.questions.length > 0
        ? await runQuestions(assessment.questions)
        : { refinements: [], scope: null, cancelled: false };
    if (asked.cancelled) {
      log.info("");
      log.info("Cancelled — nothing was changed.");
      return;
    }
    // A fresh answer is remembered so the same question isn't asked next time.
    if (asked.scope) await rememberChoice(root, scopeToChoice(asked.scope));

    // Memory-applied refinements + this run's answers + any Yellow style note.
    const answered = [...assessment.autoRefinements, ...asked.refinements];
    editScope = asked.scope ?? assessment.autoScope; // verify whichever scope applies
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

  // 4: confirm (with view / edit before sending). No pre-send token box —
  // the numbers were estimates, the Send prompt already names the target, and
  // the real usage is reported by the agent afterward.
  let manifestTokens = estimateTokens(manifest); // used only for the post-run ratio
  const target = auth.mode === "agent-cli" ? AGENT_CLIS[auth.agent].title : model;

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
            log.success("Manifest updated.");
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
    if (missing.length > 0) {
      const canPrompt = Boolean(process.stdin.isTTY) && !opts.yes;
      await handleScopeViolation(root, editScope, missing, canPrompt);
    }
  }

  // Rule enforcement: a rule may say "don't touch these paths". Verify it —
  // regardless of which agent ran — and offer to restore anything that broke it.
  if (outcome && outcome.touched.length > 0) {
    const protectedPaths = extractProtectedPaths((await loadRules(root)).text);
    if (protectedPaths.length > 0) {
      const violations = outcome.touched.filter((f) => protectedMatch(f, protectedPaths));
      if (violations.length > 0) {
        const canPrompt = Boolean(process.stdin.isTTY) && !opts.yes;
        await handleRuleViolation(root, violations, protectedPaths, canPrompt);
      }
    }
  }

  if (outcome) {
    if (!scaffold && repoTokens > 0) printContextSummary(manifestTokens, repoTokens);
    ctx.memory = { task: finalTask, touched: outcome.touched, summary: outcome.summary.slice(0, 400) };
  }

  await track("task_completed", root, {
    command: "run",
    agent: auth.mode === "agent-cli" ? auth.agent : "api",
    outcome: outcome ? "applied" : "cancelled",
    files: outcome ? outcome.touched.length : 0,
  });
}

/** Persist a duplicate-disambiguation answer, keyed by landmark so it survives edits. */
function scopeToChoice(scope: EditScope): { phrase: string; change: string[]; keep: string[] } {
  const idOf = (i: Instance) => i.landmark || i.value;
  return { phrase: scope.phrase, change: scope.change.map(idOf), keep: scope.keep.map(idOf) };
}

/**
 * The agent edited past what the user authorized. Report it, then offer to
 * surgically restore just the out-of-scope regions — keeping the rest of the
 * run — instead of reverting everything.
 */
async function handleScopeViolation(
  root: string,
  scope: EditScope,
  missing: Instance[],
  canPrompt: boolean,
): Promise<void> {
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

  let proceed = false;
  if (canPrompt) {
    const ans = await prompts({
      type: "confirm",
      name: "fix",
      message: `Restore just ${missing.length === 1 ? "that occurrence" : "those occurrences"} and keep the rest of the change?`,
      initial: true,
    });
    proceed = ans.fix === true;
  }
  if (!proceed) {
    log.dim("Left as-is. `super-t revert` undoes the whole run.");
    process.exitCode = 1;
    return;
  }

  // Restore, per file, only the hunks that touched a kept occurrence.
  const byFile = new Map<string, number[]>();
  for (const m of missing) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m.line]);

  let restored = 0;
  let files = 0;
  for (const [rel, lines] of byFile) {
    const before = await readBackupBefore(root, rel);
    if (before === null) continue;
    const after = await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "");
    const { content, reverted } = surgicalRevert(before, after, lines);
    if (reverted > 0 && content !== after) {
      await fs.writeFile(nodePath.join(root, rel), content);
      restored += reverted;
      files++;
    }
  }

  if (restored > 0) {
    log.success(`Restored ${restored} region${restored === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"} — the rest of the change is kept.`);
  } else {
    log.warn("Couldn't isolate the out-of-scope edit cleanly. `super-t revert` undoes the whole run.");
    process.exitCode = 1;
  }
}

/** Sum usage across the main run and any repair passes. */
function mergeUsage(a: AgentUsage | null, b: AgentUsage | null): AgentUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd != null || b.costUsd != null ? (a.costUsd ?? 0) + (b.costUsd ?? 0) : undefined,
  };
}

/**
 * The agent changed a file your rules protect. Report it, then offer to put
 * those files back exactly as they were — restored files it modified, deleted
 * ones it created — while keeping the rest of the run.
 */
async function handleRuleViolation(
  root: string,
  violations: string[],
  protectedPaths: string[],
  canPrompt: boolean,
): Promise<void> {
  log.info("");
  log.warn(`Rule violation — ${violations.length} protected file${violations.length === 1 ? "" : "s"} changed:`);
  for (const f of violations) log.warn(`  • ${f}  (rules protect "${protectedMatch(f, protectedPaths)}")`);

  let restore = false;
  if (canPrompt) {
    const ans = await prompts({
      type: "confirm",
      name: "fix",
      message: `Put ${violations.length === 1 ? "that file" : "those files"} back and keep the rest of the change?`,
      initial: true,
    });
    restore = ans.fix === true;
  }
  if (!restore) {
    log.dim("Left as-is. `super-t revert` undoes the whole run.");
    process.exitCode = 1;
    return;
  }

  let restored = 0;
  for (const rel of violations) {
    const before = await readBackupBefore(root, rel);
    if (before !== null) {
      await fs.writeFile(nodePath.join(root, rel), before); // agent modified a protected file → restore it
    } else {
      await fs.rm(nodePath.join(root, rel), { force: true }); // agent created it under a protected path → remove it
    }
    restored++;
  }
  log.success(`Restored ${restored} protected file${restored === 1 ? "" : "s"} — the rest of the change is kept.`);
}

/** Read a file's pre-run content from the most recent backup. */
async function readBackupBefore(root: string, rel: string): Promise<string | null> {
  const backupRoot = nodePath.join(stateDir(root), "backup");
  let runs: string[] = [];
  try {
    runs = (await fs.readdir(backupRoot)).sort();
  } catch {
    return null;
  }
  if (runs.length === 0) return null;
  const filesDir = nodePath.join(backupRoot, runs[runs.length - 1], "files");
  return fs.readFile(nodePath.join(filesDir, rel), "utf8").catch(() => null);
}

/** The product's pitch, printed after every run — the honest ratio, no raw token counts. */
function printContextSummary(sentTokens: number, repoTokens: number): void {
  // Just the share of the repo Super Terminal sent — a ratio it can stand behind. No raw
  // token numbers (they were estimates; the real usage is reported by the agent).
  const pctNum = Math.min(100, Math.max(0, (sentTokens / repoTokens) * 100));
  const sent = pctNum < 1 ? pctNum.toFixed(1) : String(Math.round(pctNum));
  const skipped = Math.max(0, 100 - Math.round(pctNum));
  log.info("");
  log.info(darkGreen(`Context: Super Terminal sent ~${sent}% of the repo — only what this task needs.`));
  if (skipped > 0) log.dim(`  The other ~${skipped}% wasn't sent.`);
}

// ---------------------------------------------------------------------------
// Provider: Anthropic API (built-in edit loop, staged edits, super-t revert)
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
  const backupFilesDir = nodePath.join(stateDir(root), "backup", runId, "files");

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
          `Validation still failing after ${MAX_REPAIRS} repair attempts. Edits are kept — review the diff, fix manually, or run \`super-t revert\`.`,
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
  const beforeMap = new Map<string, string>();
  const afterMap = new Map<string, string>();
  log.info("");
  log.info(pc.bold("Changes:"));
  for (const rel of stage.allTouched.sort()) {
    const after = await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "");
    const created = stage.wasCreated(rel);
    const before = created ? "" : await fs.readFile(nodePath.join(backupFilesDir, rel), "utf8").catch(() => "");
    beforeMap.set(rel, before);
    afterMap.set(rel, after);
    const d = renderFileDiff(rel, before, after, created);
    totalAdded += d.added;
    totalRemoved += d.removed;
    printFileDiff(rel, created, d.added, d.removed, d.rendered);
  }

  printSemanticSummary(beforeMap, afterMap);
  log.info("");
  log.info(`${stage.allTouched.length} file(s) changed, ${pc.green(`+${totalAdded}`)} ${pc.red(`−${totalRemoved}`)}`);
  if (summary) {
    log.info("");
    log.info(summary);
  }
  log.info("");
  log.dim("Undo anytime with `super-t revert`.");

  if (validationFailed) process.exitCode = 1;
  return { touched: stage.allTouched, summary };
}

// ---------------------------------------------------------------------------
// Provider: agent CLI passthrough — Claude Code / Cursor / Codex bring their
// own auth and edit loop; Super Terminal tracks and undoes changes via git
// ---------------------------------------------------------------------------

async function runViaAgentCli(
  root: string,
  manifest: string,
  opts: RunOptions,
  agent: AgentCliDef,
  index: RepoIndex,
  config: ProjectConfig,
): Promise<RunOutcome | null> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  // Snapshot file contents up front so we can diff (and revert) without git.
  const snapshot = await snapshotContents(root, index);

  const surgical = opts.surgical === true;
  const surgicalNudge = surgical
    ? "\n\nSURGICAL MODE: the manifest contains everything you need. Make the requested edit directly. Do NOT search, grep, list, or run commands, and do NOT explore other files. Read only the file you are editing, apply the change, and stop — do not re-read to verify."
    : "";

  log.info("");
  if (surgical) log.dim(`  (surgical mode: ${agent.title} restricted to a direct edit — measuring token cost)`);
  log.info(pc.dim(`── ${agent.title} is working — its live output follows ` + "─".repeat(Math.max(0, 30 - agent.title.length))));
  // The agent takes a while to boot and think before it says anything. Fill
  // that dead air with the wave, and clear it the instant real output lands.
  let usage: AgentUsage | null = null;
  const wave = pixelWave(`${agent.title} is thinking…`);
  try {
    usage = (
      await runAgent(
        agent,
        root,
        `${manifest}\n\nImplement the task now, exactly as described under "How to apply this task" — smallest change that literally satisfies it, nothing extra.${surgicalNudge}`,
        () => wave.stop(),
        surgical,
      )
    ).usage;
    wave.stop(); // agent finished without ever printing
  } catch (err) {
    wave.stop();
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
      const repairWave = pixelWave(`${agent.title} is thinking…`);
      try {
        usage = mergeUsage(usage, (await continueAgent(agent, root, repairPrompt(failed), () => repairWave.stop(), surgical)).usage);
        repairWave.stop();
      } catch (err) {
        repairWave.stop();
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

  printSemanticSummary(
    new Map(changes.map((c) => [c.path, c.before])),
    new Map(changes.map((c) => [c.path, c.after])),
  );
  log.info("");
  log.info(`${changes.length} file(s) changed, ${pc.green(`+${totalAdded}`)} ${pc.red(`−${totalRemoved}`)}`);
  log.info("");
  log.dim("Undo anytime with `super-t revert`.");

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
 * <state>/backup/<runId>/ (so `super-t revert` works), and return the diffs.
 */
async function backupAndDiff(
  root: string,
  config: ProjectConfig,
  snapshot: Map<string, string>,
  runId: string,
): Promise<FileChange[]> {
  const after = await indexRepo(root, config); // re-scan to pick up newly created files
  const backupFilesDir = nodePath.join(stateDir(root), "backup", runId, "files");
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
    await fs.mkdir(nodePath.join(stateDir(root), "backup", runId), { recursive: true });
    await fs.writeFile(
      nodePath.join(stateDir(root), "backup", runId, "created.json"),
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

function hintAuth(err: unknown): void {
  const msg = err instanceof Error ? err.message : "";
  if (err instanceof Anthropic.AuthenticationError || msg.includes("authentication method")) {
    log.info("Credentials were rejected or missing. Run `super-t connect` to (re)connect.");
  }
}
