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

// "glint" pixel wordmark — the `g` matches the Glint SVG logo's block pattern.
const GLYPHS: Record<string, string[]> = {
  g: [".###", "#..#", ".###", "...#", "####"],
  l: ["#.", "#.", "#.", "#.", "##"],
  i: ["#.", "..", "#.", "#.", "#."],
  n: ["....", "###.", "#..#", "#..#", "#..#"],
  t: [".#.", "###", ".#.", ".#.", ".##"],
};
const PIXEL = "█";
const ROWS = 5;

function wordmarkRows(word: string): string[] {
  const glyphs = [...word].map((c) => GLYPHS[c]).filter(Boolean);
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    rows.push(
      glyphs.map((g) => [...g[r]].map((px) => (px === "#" ? PIXEL + PIXEL : "  ")).join("")).join("  "),
    );
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

const DESCRIPTION =
  "Glint sends your AI coding agent only the code each task needs — a compact, task-specific manifest instead of the whole repo. Fewer tokens, sharper edits, every change reviewed and reversible.";

/**
 * Responsive welcome box (~80% of terminal width): pixel wordmark + Welcome +
 * connection on the left, a divider, description + getting-started on the
 * right. Falls back to a stacked layout when the terminal is too narrow.
 */
export async function renderHeader(version: string, mode: "welcome" | "session" = "welcome"): Promise<string> {
  const conn = await connectionInfo();
  const name = await userName();
  const art = wordmarkRows("glint");
  const artW = art[0].length;

  const cols = process.stdout.columns ?? 80;
  const boxWidth = Math.round(cols * 0.8);
  const leftW = artW;
  const rightW = boxWidth - leftW - 7; // "│ " + left + " │ " + right + " │"

  const dot = conn.connected ? lime("●") : pc.dim("○");
  const status = conn.connected ? pc.dim(`connected · ${conn.label}`) : pc.dim("not connected");

  if (rightW < 26) return stacked(version, art, dot, conn, name);

  const left: string[] = [
    "", // top margin so the logo doesn't hug the border
    ...art.map((r) => center(lime(r), leftW)),
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
          cmd("glint run", '"task"', "start a session"),
          cmd("glint switch", "", "change agent"),
          cmd("glint search", "", "switch project"),
          cmd("glint plan", '"task"', "preview (free)"),
        ];
  const right: string[] = [
    "", // align with the left column's top margin
    pc.bold("What is Glint?"),
    ...wrap(DESCRIPTION, rightW).map((l) => pc.dim(l)),
    "",
    ...commands,
  ];

  const rows = Math.max(left.length, right.length);
  const title = ` glint · v${version} `;
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
  const w = art[0].length;
  const lines = [""];
  for (const row of art) lines.push("  " + lime(row));
  lines.push("");
  lines.push("  " + center(limeBold(`Welcome, ${name}!`), w));
  lines.push("");
  lines.push("  " + pc.dim(`precision context for AI coding agents · v${version}`));
  lines.push(
    "  " + dot + " " + pc.dim(conn.connected ? `connected · ${conn.label}` : "not connected — run `glint connect`"),
  );
  return lines.join("\n");
}
