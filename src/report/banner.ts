import os from "node:os";
import pc from "picocolors";
import { execa } from "execa";
import { resolveAuth } from "../util/globalConfig";
import { AGENT_CLIS } from "../claude/agentCli";

const LIME = "\x1b[38;2;243;249;255m"; // brand light #F3F9FF on the blue bg (name kept)
const RESET = "\x1b[0m";
const on = pc.isColorSupported;
const lime = (s: string) => (on ? `${LIME}${s}${RESET}` : s);
const limeBold = (s: string) => (on ? `\x1b[1m${LIME}${s}${RESET}` : s);

// The Super Terminal mark, built from its pixel construction rather than
// traced from the SVG outline.
//
// The form: one small box is a solid cell; four of them (2x2) make a large
// square; LARGE_SQUARES of those in a row make a bar. Two bars stack with no
// gap, and the top bar begins at the second large square of the bottom one —
// which is what gives the mark its lean.
//
// Each small cell is drawn as two "█" on one text row: a terminal cell is
// about twice as tall as it is wide, so two of them side by side read square.
// Tracing the SVG's diagonal instead meant antialiasing a 17-degree edge
// across very few pixels, which rendered as a smudge at any size that fit the
// header. Blocks are what the mark is actually made of, so they stay crisp.

const LARGE_SQUARES = 5; // large squares per bar
const CELLS_PER_SQUARE = 2; // a large square is 2x2 small cells
const BAR_CELLS = LARGE_SQUARES * CELLS_PER_SQUARE; // small cells per bar
const OFFSET_CELLS = CELLS_PER_SQUARE; // top bar starts one large square in
const MARK_ROWS = 4; // two bars, each two small cells tall

/** The mark as terminal rows, light on whatever the terminal background is. */
function iconRows(): string[] {
  const width = BAR_CELLS + OFFSET_CELLS;
  const rows: string[] = [];
  for (let r = 0; r < MARK_ROWS; r++) {
    const from = r < MARK_ROWS / 2 ? OFFSET_CELLS : 0; // top bar is the offset one
    let line = "";
    for (let c = 0; c < width; c++) line += c >= from && c < from + BAR_CELLS ? "██" : "  ";
    rows.push(on ? `${LIME}${line}${RESET}` : line);
  }
  return rows;
}

function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function padTo(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - vlen(s)));
}
/** Truncate to a visible width, preserving ANSI color codes. Prevents any line from breaking the box. */
function clip(s: string, w: number): string {
  if (vlen(s) <= w) return s;
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < w - 1) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i++];
    visible++;
  }
  return out + "…" + RESET;
}
function cell(s: string, w: number): string {
  return padTo(clip(s, w), w);
}
function center(s: string, w: number): string {
  const total = Math.max(0, w - vlen(s));
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function homeRelative(dir: string): string {
  const home = os.homedir();
  return dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
}

async function userName(): Promise<string> {
  const first = (s: string | undefined) => s?.trim().split(/\s+/)[0] || "";
  // git identity, then the OS account's real name (macOS `id -F`), then username
  try {
    const git = first((await execa("git", ["config", "user.name"], { reject: false, timeout: 2000 })).stdout);
    if (git) return git;
  } catch {
    // git not available
  }
  try {
    const real = first((await execa("id", ["-F"], { reject: false, timeout: 2000 })).stdout);
    if (real) return real;
  } catch {
    // not macOS / id -F unsupported
  }
  const u = os.userInfo().username;
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : "there";
}

async function connectionInfo(): Promise<{ connected: boolean; label: string }> {
  const auth = await resolveAuth();
  if (!auth) return { connected: false, label: "not connected" };
  const label =
    auth.mode === "agent-cli"
      ? AGENT_CLIS[auth.agent].title
      : auth.mode === "oauth"
        ? "Anthropic (browser login)"
        : "Anthropic API";
  return { connected: true, label };
}

const NAME = "Super Terminal";
const DESCRIPTION =
  "Super Terminal is the control layer for AI coding agents. Your rules, context, and skills apply to Claude Code, Cursor, and Codex alike — and several agents can be chained into one workflow. Every change is reviewed and reversible.";

/**
 * Responsive welcome box (~80% of terminal width): the mark, name, and
 * connection on the left, a divider, description + getting-started on the
 * right. Falls back to a stacked layout when the terminal is too narrow.
 */
export async function renderHeader(version: string, mode: "welcome" | "session" = "welcome"): Promise<string> {
  const conn = await connectionInfo();
  const name = await userName();
  const art = iconRows();
  // Width must come from the VISIBLE length — every icon row carries two ANSI
  // colour codes per cell, so .length is many times the rendered width.
  const artW = vlen(art[0]);

  const cols = process.stdout.columns ?? 80;
  const boxWidth = Math.round(cols * 0.8);
  const dot = conn.connected ? lime("●") : pc.dim("○");
  const statusText = conn.connected ? `connected · ${conn.label}` : "not connected";
  const status = pc.dim(statusText);

  // Size the column to what goes in it — sizing to the icon alone truncated the
  // agent name to "connected · C…" — but never let it starve the right column,
  // which is what actually tells a new user how to start.
  const wanted = Math.max(artW, NAME.length, `Welcome, ${name}!`.length, statusText.length + 2);
  const leftW = Math.max(artW, Math.min(wanted, boxWidth - 7 - 34));
  const rightW = boxWidth - leftW - 7; // "│ " + left + " │ " + right + " │"

  if (rightW < 26) return stacked(version, art, dot, conn, name);

  const left: string[] = [
    "", // top margin so the logo doesn't hug the border
    ...art.map((r) => center(r, leftW)),
    "",
    center(limeBold(NAME), leftW),
    "",
    center(limeBold(`Welcome, ${name}!`), leftW),
    "",
    `${dot} ${status}`,
    pc.dim(homeRelative(process.cwd())),
  ];

  const cmd = (name: string, arg: string, desc: string) =>
    `${lime(name)}${arg ? " " + pc.dim(arg) : ""}  ${pc.dim(desc)}`;
  const commands =
    mode === "session"
      ? [
          pc.bold("In this session"),
          cmd("type a task", "", "run it now"),
          cmd("/plan", "<task>", "preview, don't send"),
          cmd("/switch", "", "change agent"),
          cmd("/search", "", "switch project"),
          cmd("/clear", "", "clean the screen"),
          cmd("/exit", "", "quit"),
        ]
      : [
          pc.bold("Getting started"),
          cmd("super-t run", '"task"', "start a session"),
          cmd("super-t switch", "", "change agent"),
          cmd("super-t search", "", "switch project"),
          cmd("super-t plan", '"task"', "preview (free)"),
        ];
  const right: string[] = [
    "", // align with the left column's top margin
    pc.bold(`What is ${NAME}?`),
    ...wrap(DESCRIPTION, rightW).map((l) => pc.dim(l)),
    "",
    ...commands,
  ];

  const rows = Math.max(left.length, right.length);
  const title = ` ${NAME} · v${version} `;
  const out: string[] = [];
  out.push(lime("╭─" + title + "─".repeat(Math.max(0, boxWidth - 3 - title.length)) + "╮"));
  for (let i = 0; i < rows; i++) {
    out.push(`${lime("│")} ${cell(left[i] ?? "", leftW)} ${lime("│")} ${cell(right[i] ?? "", rightW)} ${lime("│")}`);
  }
  out.push(lime("╰" + "─".repeat(boxWidth - 2) + "╯"));
  return "\n" + out.join("\n");
}

function stacked(
  version: string,
  art: string[],
  dot: string,
  conn: { connected: boolean; label: string },
  name: string,
): string {
  const w = Math.max(vlen(art[0]), NAME.length);
  const lines = [""];
  for (const row of art) lines.push("  " + row);
  lines.push("");
  lines.push("  " + center(limeBold(NAME), w));
  lines.push("  " + center(limeBold(`Welcome, ${name}!`), w));
  lines.push("");
  lines.push("  " + pc.dim(`one control layer for every AI coding agent · v${version}`));
  lines.push(
    "  " + dot + " " + pc.dim(conn.connected ? `connected · ${conn.label}` : "not connected — run `super-t connect`"),
  );
  return lines.join("\n");
}
