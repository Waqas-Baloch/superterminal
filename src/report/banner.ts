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

// The Super Terminal icon: a light tile with one blue stepped shape near the
// bottom.
//
// The shape is built from its pixel construction — four small cells make a
// large square, five large squares make a bar, and two bars stack with the top
// one starting at the second large square of the bottom, which creates the
// lean. The two bars touch, forming a single shape.
//
// Drawn with upper-half blocks (▀) carrying BOTH a foreground and a background
// colour, so every character cell is filled edge to edge. Using full blocks (█)
// on consecutive rows instead leaves visible horizontal seams between rows,
// because the glyph doesn't cover the cell's full line height in most terminal
// fonts — which made one continuous shape look like separate stripes.

type RGB = [number, number, number];
const BLUE: RGB = [0, 64, 255]; // #0040FF — the bars
const PAPER: RGB = [243, 249, 255]; // #F3F9FF — the tile

const BOX = 18; // the icon is BOX x BOX square cells
const LARGE_SQUARES = 5; // large squares per bar
const CELLS_PER_SQUARE = 2; // a large square is 2x2 small cells
const BAR_W = LARGE_SQUARES * CELLS_PER_SQUARE; // 10 cells
const OFFSET = CELLS_PER_SQUARE; // top bar starts one large square in
const MARK_W = BAR_W + OFFSET;
const MARK_H = 4; // two bars, two cells each
const MARK_X = Math.round((BOX - MARK_W) / 2); // centred horizontally
const MARK_Y = 11; // sits low in the tile, as in the icon

/** Colour of one square cell of the icon. */
function cellColor(x: number, y: number): RGB {
  const mx = x - MARK_X;
  const my = y - MARK_Y;
  if (my >= 0 && my < MARK_H && mx >= 0 && mx < MARK_W) {
    const from = my < MARK_H / 2 ? OFFSET : 0; // upper bar is the offset one
    if (mx >= from && mx < from + BAR_W) return BLUE;
  }
  return PAPER;
}

const rgb = (c: RGB, layer: 38 | 48): string => `\x1b[${layer};2;${c[0]};${c[1]};${c[2]}m`;

/** The icon as terminal rows: BOX cells wide, BOX/2 rows tall. */
function iconRows(): string[] {
  if (!on) {
    // No colour: draw the shape solid and the tile as light shade, so the
    // icon still reads without relying on colour at all.
    const out: string[] = [];
    for (let r = 0; r < BOX / 2; r++) {
      let line = "";
      for (let x = 0; x < BOX; x++) line += cellColor(x, r * 2) === BLUE ? "█" : "░";
      out.push(line);
    }
    return out;
  }
  const out: string[] = [];
  for (let r = 0; r < BOX / 2; r++) {
    let line = "";
    for (let x = 0; x < BOX; x++) {
      line += `${rgb(cellColor(x, r * 2), 38)}${rgb(cellColor(x, r * 2 + 1), 48)}▀`;
    }
    out.push(line + RESET);
  }
  return out;
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
