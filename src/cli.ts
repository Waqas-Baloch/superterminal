#!/usr/bin/env node
import { Command } from "commander";
import { planCommand } from "./commands/plan";
import { runCommand } from "./commands/run";
import { revertCommand } from "./commands/revert";
import { connectCommand } from "./commands/connect";
import { switchCommand } from "./commands/switch";
import { renderHeader } from "./report/banner";

const VERSION = "0.1.1";
const program = new Command();

program
  .name("glint")
  .description("Compress a codebase into a task-specific manifest for any AI coding agent")
  .version(VERSION);

program
  .command("run")
  .argument("[task]", 'task description, e.g. "add checkout form" (omit to start an empty session)')
  .option("--budget <tokens>", "manifest token budget")
  .option("--model <model>", "Claude model id")
  .option("-y, --yes", "skip confirmation (also disables session mode — single shot)")
  .option("--no-validate", "skip local validation")
  .option("--no-focus", "send whole files instead of task-relevant excerpts")
  .option("--no-ask", "skip clarifying questions")
  .description("start a glint session: run tasks continuously until /exit")
  .action(runCommand);

program
  .command("plan")
  .argument("<task>", "task description")
  .option("--budget <tokens>", "manifest token budget")
  .option("--no-focus", "send whole files instead of task-relevant excerpts")
  .description("dry run: show what would be selected and sent, without calling Claude")
  .action(planCommand);

program
  .command("connect")
  .description("one-time connection to your AI (API key, browser login, Claude Code, Cursor, ChatGPT)")
  .action(connectCommand);

program
  .command("switch")
  .description("switch the active coding agent (Claude Code / Cursor / ChatGPT / API)")
  .action(switchCommand);

program
  .command("revert")
  .description("restore files from the last run's backup")
  .action(revertCommand);

// Bare `glint` (no command) shows the welcome box (wordmark + status + commands).
if (process.argv.length <= 2) {
  renderHeader(VERSION).then((header) => console.log(header + "\n"));
} else {
  program.parseAsync();
}
