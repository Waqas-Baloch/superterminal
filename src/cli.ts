#!/usr/bin/env node
import { Command } from "commander";
import { planCommand } from "./commands/plan";
import { runCommand } from "./commands/run";
import { revertCommand } from "./commands/revert";
import { forgetCommand } from "./commands/forget";
import { initCommand } from "./commands/init";
import { compareCommand } from "./commands/compare";
import { connectCommand } from "./commands/connect";
import { switchCommand } from "./commands/switch";
import { searchCommand } from "./commands/search";
import { renderHeader } from "./report/banner";
import { VERSION } from "./version";

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
  .option("--surgical", "experimental: restrict Claude Code to a direct edit (no repo exploration) to measure token cost")
  .description("start a glint session: run tasks continuously until /exit")
  .action(runCommand);

program
  .command("plan")
  .argument("<task>", "task description")
  .option("--budget <tokens>", "manifest token budget")
  .option("--no-focus", "send whole files instead of task-relevant excerpts")
  .option("--show", "print the full generated manifest")
  .option("--out <file>", "write the manifest to a file")
  .description("dry run: show what would be selected and sent, without calling Claude")
  .action(planCommand);

program
  .command("init")
  .description("draft a .glint/rules.md for this repo (rules Glint applies to every agent)")
  .action(initCommand);

program
  .command("connect")
  .description("one-time connection to your AI (API key, browser login, Claude Code, Cursor, ChatGPT)")
  .action(connectCommand);

program
  .command("switch")
  .description("switch the active coding agent (Claude Code / Cursor / ChatGPT / API)")
  .action(switchCommand);

program
  .command("search")
  .argument("[query]", "optional name filter, e.g. glint search shop")
  .description("find a project folder and start a session there")
  .action(searchCommand);

program
  .command("compare")
  .argument("<task>", "task description")
  .option("--budget <tokens>", "manifest token budget")
  .description("run the same task through every connected agent and keep the best result")
  .action(compareCommand);

program
  .command("revert")
  .description("restore files from the last run's backup")
  .action(revertCommand);

program
  .command("forget")
  .description("clear the choices Glint has learned for this repo (.glint/intent.json)")
  .action(forgetCommand);

// Bare `glint` (no command) shows the welcome box (wordmark + status + commands).
if (process.argv.length <= 2) {
  renderHeader(VERSION).then((header) => console.log(header + "\n"));
} else {
  program.parseAsync();
}
