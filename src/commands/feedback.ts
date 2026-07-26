import pc from "picocolors";
import prompts from "prompts";
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { execa } from "execa";
import { validUsername, currentGitHubUser } from "../core/team";
import { stateDir } from "../util/paths";
import { log } from "../util/logger";

// `super-t feedback <github-username>` — ask a human to review your last run.
//
// The request becomes a GitHub issue holding the run report, assigned to the
// reviewer and mentioning you. Their reply is issue comments, which means the
// feedback loop closes inside `super-t ticket`: the issue is assigned work,
// so it shows up in your own ticket list.
//
// This is the individual's version of the team's approval flow — no server, no
// account, just GitHub identities both people already have.

export async function feedbackCommand(username?: string, opts: { message?: string } = {}): Promise<void> {
  const root = process.cwd();
  const name = (username ?? "").trim();
  if (!validUsername(name)) {
    log.error("Usage: super-t feedback <github-username>");
    log.dim("  Asks that person to review your last run, as a GitHub issue they're assigned.");
    process.exitCode = 1;
    return;
  }

  const report = await latestReport(root);
  if (!report) {
    log.error("No run report to share yet — run a task first.");
    process.exitCode = 1;
    return;
  }
  const me = await currentGitHubUser(root);

  const title = `Review request: ${firstTask(report.body) || "recent changes"}`.slice(0, 110);
  const body = [
    `@${name} — could you review this change?${me ? ` Requested by @${me}.` : ""}`,
    opts.message?.trim() ? `\n> ${opts.message.trim()}` : "",
    "",
    report.body, // already secret-redacted when written
    "",
    "---",
    "_Reply in the comments. This issue is assigned to you, so it appears in your `super-t ticket` list._",
  ]
    .filter(Boolean)
    .join("\n");

  log.info("");
  log.info(`Asking ${pc.bold(name)} to review — this creates a GitHub issue in this repository.`);
  log.dim(`  Title: ${title}`);
  if (!process.stdin.isTTY) {
    log.error("Creating an issue is public — run this in a terminal so it can be confirmed.");
    process.exitCode = 1;
    return;
  }
  const { go } = await prompts({ type: "confirm", name: "go", message: "Create the review request?", initial: false });
  if (!go) {
    log.info("Cancelled — no issue created.");
    return;
  }

  const r = await execa("gh", ["issue", "create", "--title", title, "--body-file", "-", "--assignee", name], {
    cwd: root,
    reject: false,
    timeout: 30_000,
    input: body,
  }).catch(() => null);

  if (r?.exitCode === 0) {
    const url = r.stdout.trim().split("\n").pop() ?? "";
    log.success(`Review requested from ${name}.`);
    if (url) log.info(`  ${url}`);
    log.dim("  Their comments land on that issue — and it shows in your `super-t ticket` list too.");
  } else {
    log.error("Couldn't create the issue.");
    log.dim(`  ${(r?.stderr ?? "").slice(0, 200)}`);
    log.dim(`  Check that ${name} can be assigned in this repository (they may need access).`);
    process.exitCode = 1;
  }
}

function firstTask(body: string): string {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.startsWith("**Task**"));
  return i >= 0 ? (lines[i + 1] ?? "").trim().slice(0, 70) : "";
}

async function latestReport(root: string): Promise<{ path: string; body: string } | null> {
  try {
    const dir = nodePath.join(stateDir(root), "reports");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) return null;
    const path = nodePath.join(dir, files[files.length - 1]);
    return { path, body: await fs.readFile(path, "utf8") };
  } catch {
    return null;
  }
}
