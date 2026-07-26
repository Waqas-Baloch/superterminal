import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { stateDir, ensureStateDir } from "../util/paths";
import type { CriterionVerdict } from "../core/criteria";
import { statusMark } from "../core/criteria";

// The PM-readable run report: what was asked, what changed, what was verified,
// how to undo. Written per run under <state>/reports/ — the artifact that later
// gets posted to a ticket. Deliberately markdown, deliberately code-free.

export interface RunReportInput {
  task: string;
  agent: string; // who implemented
  reviewer?: string; // who gave the second opinion, if any
  approved?: boolean; // reviewer's overall verdict
  files: string[]; // repo-relative changed files
  criteria: string[]; // the acceptance criteria found for this task
  verdicts: CriterionVerdict[]; // one per criterion — EMPTY when no review ran
  notes: string[]; // reviewer findings / verification warnings
  /** Why no verdicts exist, when criteria were found but not checked. */
  notCheckedReason?: string;
}

// Phase-1 security gate (docs/security-protocols.md): reports may travel to
// tickets and chats, so token-shaped strings never survive into one.
const TOKEN_RE = new RegExp(
  [
    // prefix_ styles: OpenAI, GitHub, GitLab, Slack, PostHog personal, Notion, Linear
    String.raw`\b(?:sk|rk|ghp|gho|ghs|glpat|xox[a-z]|phx|ntn|secret|lin_api)_[A-Za-z0-9_-]{8,}\b`,
    // Atlassian (Jira/Confluence) tokens carry NO underscore, so the pattern
    // above missed them entirely — and reports travel to tickets and chats.
    String.raw`\bAT(?:ATT|CTT)[A-Za-z0-9_\-=]{16,}\b`,
    String.raw`\bBearer\s+[A-Za-z0-9._-]{12,}\b`,
  ].join("|"),
  "gi",
);

export function redactSecrets(text: string): string {
  return text.replace(TOKEN_RE, "[redacted]");
}

export function renderRunReport(input: RunReportInput): string {
  const met = input.verdicts.filter((v) => v.status === "met").length;
  const lines: string[] = [
    `# Run report — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `**Task**`,
    input.task.split("\n")[0].slice(0, 300),
    "",
    `**Implemented by:** ${input.agent}${input.reviewer ? `  ·  **Reviewed by:** ${input.reviewer} (different vendor)` : ""}`,
    "",
    `**Files changed (${input.files.length})**`,
    ...input.files.slice(0, 30).map((f) => `- ${f}`),
  ];

  if (input.criteria.length > 0 && input.verdicts.length === 0) {
    // Nothing checked them. Reporting "0 of N met" here would read as "the work
    // failed" — the opposite of the truth, on a summary a PM may act on.
    lines.push("", `**Acceptance criteria — not checked** (${input.notCheckedReason ?? "no reviewer ran"})`);
    for (const [i, c] of input.criteria.entries()) lines.push(`- ? ${i + 1}. ${c}`);
    lines.push("", "_To have a different vendor check each criterion, add `review: codex` to your rules file._");
  } else if (input.criteria.length > 0) {
    lines.push("", `**Acceptance criteria — ${met} of ${input.criteria.length} met**`);
    for (const v of input.verdicts) {
      const text = input.criteria[v.index - 1] ?? "";
      lines.push(`- ${statusMark(v.status)} ${v.index}. ${text}${v.note && v.status !== "met" ? ` — _${v.note}_` : ""}`);
    }
  } else if (input.reviewer) {
    lines.push("", `**Review verdict:** ${input.approved ? "approved" : "issues raised"}`);
  }

  if (input.notes.length > 0) {
    lines.push("", "**Findings**");
    for (const n of input.notes.slice(0, 10)) lines.push(`- ${n}`);
  }

  lines.push("", "---", "Undo everything from this run: `super-t revert`", "");
  return redactSecrets(lines.join("\n"));
}

/** Write the report; returns its repo-relative path (or null if writing failed). */
export async function writeRunReport(root: string, input: RunReportInput): Promise<string | null> {
  try {
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    await ensureStateDir(root);
    const dir = nodePath.join(stateDir(root), "reports");
    await fs.mkdir(dir, { recursive: true });
    const file = nodePath.join(dir, `${id}.md`);
    await fs.writeFile(file, renderRunReport(input));
    return nodePath.relative(root, file);
  } catch {
    return null; // reporting must never fail a run
  }
}
