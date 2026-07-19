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

// The Super Terminal mark, drawn from the same geometry as
// assets/SuperTerminalIcon.svg: a solid #0040FF square with one slanted
// near-white bar across the lower third.
//
// Rendered with upper-half blocks (▀), so each character cell carries two
// stacked pixels — foreground paints the top half, background the bottom.
// That doubles vertical resolution and makes each pixel square, since a cell
// is about twice as tall as it is wide.
const BLUE: RGB = [0, 64, 255]; // #0040FF
const PAPER: RGB = [243, 249, 255]; // #F3F9FF
const VIEWBOX = 151;

// Parallelogram vertices, straight from the SVG path. Top and bottom edges are
// horizontal, so "inside" is a simple span test per scanline.
const BAR = { top: 99.5227, bottom: 128.693, topLeft: 41.1818, topRight: 126.977, bottomLeft: 24.0227 };
const SLANT = BAR.bottomLeft - BAR.topLeft; // how far the bar leans as it descends

type RGB = [number, number, number];

/** Is this point inside the slanted bar? */
function inBar(x: number, y: number): boolean {
  if (y < BAR.top || y > BAR.bottom) return false;
  const t = (y - BAR.top) / (BAR.bottom - BAR.top);
  return x >= BAR.topLeft + SLANT * t && x <= BAR.topRight + SLANT * t;
}

/**
 * Colour of one pixel, supersampled 4×4 so the slanted edges are shaded rather
 * than jagged — a hard threshold turns a 17° slant into a visible staircase at
 * this size.
 */
function pixelColor(px: number, py: number, size: number): RGB {
  const step = VIEWBOX / size;
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = (px + (sx + 0.5) / 4) * step;
      const y = (py + (sy + 0.5) / 4) * step;
      if (inBar(x, y)) hits++;
    }
  }
  const k = hits / 16;
  return [
    Math.round(BLUE[0] + (PAPER[0] - BLUE[0]) * k),
    Math.round(BLUE[1] + (PAPER[1] - BLUE[1]) * k),
    Math.round(BLUE[2] + (PAPER[2] - BLUE[2]) * k),
  ];
}

/** The icon as terminal rows. `rows` characters tall, `rows * 2` wide (square). */
function iconRows(rows: number): string[] {
  const size = rows * 2; // pixels per side
  if (!on) {
    // No colour: shade the square and fill the bar solid, so the mark still
    // reads as a logo rather than as debug output.
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let x = 0; x < size; x++) {
        const step = VIEWBOX / size;
        line += inBar((x + 0.5) * step, (r * 2 + 1) * step) ? "█" : "░";
      }
      out.push(line);
    }
    return out;
  }
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const [tr, tg, tb] = pixelColor(x, r * 2, size);
      const [br, bg, bb] = pixelColor(x, r * 2 + 1, size);
      line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
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
  // 10 rows, not 8: the bar spans only ~19% of the icon's height, so at 8 rows
  // it lands mostly on pixel boundaries and renders as a faint smudge (8 solid
  // cells against 12 half-lit). At 10 it resolves to 22 solid and 2 half-lit —
  // the slant reads cleanly. Larger sizes blur again as the edges fall
  // mid-pixel once more.
  const art = iconRows(10);
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
