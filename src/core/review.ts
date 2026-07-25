import pc from "picocolors";
import { AGENT_CLIS, runAgent, isAgentInstalled, type AgentCliDef } from "../claude/agentCli";
import { agentFrom } from "./flow";
import type { AgentCliId } from "../util/globalConfig";
import type { ProjectConfig } from "../util/config";
import { log } from "../util/logger";

// Second Opinion: a DIFFERENT vendor reviews every accepted diff against your
// rules. Codex reviews Codex and Claude reviews Claude everywhere else — only
// a neutral layer can make one vendor check another's work. This is separation
// of duties, the thing engineering orgs already require of humans.
//
// Advisory by design: the verdict is printed, never auto-reverted. The human
// stays the decision-maker; `super-t revert` is one command away.

/** Who reviews: config `reviewer:`, or a `review: codex` line in any rules file. */
export function resolveReviewer(config: ProjectConfig, rulesText: string): AgentCliId | null {
  if (config.reviewer) return config.reviewer;
  const m = rulesText.match(/^\s*review:\s*([a-z ()-]+?)\s*$/im);
  return m ? agentFrom(m[1]) : null;
}

export interface ReviewVerdict {
  approved: boolean;
  notes: string[];
  reviewer: string;
}

/**
 * The reviewer's instructions. A fixed first-line verdict format so the result
 * is machine-checkable; free-form findings after it for the human.
 */
export function buildReviewPrompt(task: string, changedFiles: string[], rulesText: string): string {
  return [
    "You are reviewing another AI coding agent's changes to this repository. You did not write them.",
    "Do NOT modify any files. Read only.",
    "",
    `## The task that was given\n${task}`,
    `## Files the other agent changed\n${changedFiles.map((f) => `- ${f}`).join("\n")}`,
    rulesText ? `## Project rules the changes must respect\n${rulesText}` : "",
    "",
    "Inspect the changed files (git diff if available, otherwise read them) and judge:",
    "1. Do the changes do what the task asked — nothing missing, nothing extra?",
    "2. Do they respect every project rule above?",
    "3. Any bug, broken reference, or unintended side effect?",
    "",
    'Reply with EXACTLY this format: first line "VERDICT: APPROVE" if the changes are correct and in-scope,',
    'or "VERDICT: ISSUES" if not. Then one bullet per finding (file, problem, why it matters). No other preamble.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Parse the reviewer's reply. Unparseable output degrades to advisory notes, never a fake APPROVE. */
export function parseVerdict(text: string, reviewer: string): ReviewVerdict {
  const m = text.match(/VERDICT:\s*(APPROVE|ISSUES)/i);
  const notes = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, ""))
    .slice(0, 10);
  if (m) return { approved: m[1].toUpperCase() === "APPROVE", notes, reviewer };
  // No verdict line: treat as issues if it raised anything, otherwise unknown-but-quiet.
  return { approved: notes.length === 0, notes: notes.length ? notes : [], reviewer };
}

/**
 * Run the second opinion, print the verdict. Returns the verdict, or null when
 * review isn't configured / possible (no reviewer, reviewer==author, not installed).
 */
export async function secondOpinion(opts: {
  root: string;
  task: string;
  changedFiles: string[];
  rulesText: string;
  authorId: AgentCliId | "api";
  config: ProjectConfig;
}): Promise<ReviewVerdict | null> {
  const reviewerId = resolveReviewer(opts.config, opts.rulesText);
  if (!reviewerId || opts.changedFiles.length === 0) return null;
  if (reviewerId === opts.authorId) {
    log.dim(`  Second opinion skipped — reviewer (${reviewerId}) is the author. Set a different vendor.`);
    return null;
  }
  const reviewer: AgentCliDef = AGENT_CLIS[reviewerId];
  if (!(await isAgentInstalled(reviewer.bin))) {
    log.dim(`  Second opinion skipped — ${reviewer.title} isn't installed.`);
    return null;
  }

  log.info("");
  log.info(pc.dim(`── Second opinion · ${reviewer.title} reviewing ${"─".repeat(Math.max(0, 24 - reviewer.title.length))}`));
  try {
    // "review" mode: read-only where the vendor supports it — a reviewer that
    // can edit isn't a reviewer.
    const r = await runAgent(reviewer, opts.root, buildReviewPrompt(opts.task, opts.changedFiles, opts.rulesText), undefined, false, "review");
    const verdict = parseVerdict(r.text, reviewer.title);
    if (verdict.approved) {
      log.success(`Second opinion (${reviewer.title}): approved.`);
    } else {
      log.warn(`Second opinion (${reviewer.title}) raised ${verdict.notes.length || "unspecified"} issue(s):`);
      for (const n of verdict.notes) log.info(`    · ${n}`);
      log.dim("  Advisory only — undo everything with `super-t revert` if you agree.");
    }
    return verdict;
  } catch (err) {
    log.dim(`  Second opinion unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
