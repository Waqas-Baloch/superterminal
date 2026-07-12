import os from "node:os";
import pc from "picocolors";
import { resolveAuth } from "../util/globalConfig";
import { AGENT_CLIS } from "../claude/agentCli";

const LIME = "\x1b[38;5;154m";
const RESET = "\x1b[0m";
const on = pc.isColorSupported;
const lime = (s: string) => (on ? `${LIME}${s}${RESET}` : s);

// "glint" as a lowercase pixel wordmark in the Press Start 2P arcade style.
// 7-row cells (ascenders on l/t, dot on i, tail on g); each on-pixel renders
// as a 2-char block for a square aspect.
const ROWS = 7;
const GLYPHS: Record<string, string[]> = {
  g: [".....", ".####", "#...#", "#...#", ".####", "....#", "####."],
  l: ["#.", "#.", "#.", "#.", "#.", "#.", "##"],
  i: ["#.", "..", "#.", "#.", "#.", "#.", "#."],
  n: [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  t: [".#..", ".#..", "####", ".#..", ".#..", ".#..", ".###"],
};
const PIXEL = "█";

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
function homeRelative(dir: string): string {
  const home = os.homedir();
  return dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
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

/**
 * Claude-Code-style welcome box: pixel wordmark + connection on the left, a
 * vertical divider, command reference on the right, all inside an outlined box.
 * Falls back to a stacked layout when the terminal is too narrow.
 */
export async function renderHeader(version: string): Promise<string> {
  const conn = await connectionInfo();
  const art = wordmarkRows("glint");
  const artW = art[0].length;

  const dot = conn.connected ? lime("●") : pc.dim("○");
  const status = conn.connected
    ? pc.dim(`connected · ${conn.label}`)
    : pc.dim("not connected — run ") + pc.bold("glint connect");
  const leftMeta = ["", `${dot} ${status}`, pc.dim(homeRelative(process.cwd()))];
  const left = [...art.map((r) => lime(r)), ...leftMeta];
  const leftW = Math.max(artW, ...left.map(vlen));

  const cmd = (name: string, arg: string, desc: string) =>
    `${lime(name)}${arg ? " " + pc.dim(arg) : ""}  ${pc.dim(desc)}`;
  const right = [
    "",
    pc.bold("commands"),
    "",
    cmd("glint run", '"task"', "start a session"),
    cmd("glint switch", "", "change coding agent"),
    cmd("glint connect", "", "set up / re-auth"),
    cmd("glint plan", '"task"', "preview · free"),
    cmd("glint revert", "", "undo last run"),
  ];
  const rightW = Math.max(...right.map(vlen));

  const total = 2 + leftW + 3 + rightW + 2; // "│ " + left + " │ " + right + " │"
  const cols = process.stdout.columns ?? 80;
  if (cols < total) return stacked(version, art, dot, conn);

  const title = ` glint · v${version} `;
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  out.push(lime("╭─" + title + "─".repeat(Math.max(0, total - 4 - title.length)) + "╮"));
  for (let i = 0; i < rows; i++) {
    const l = padTo(left[i] ?? "", leftW);
    const r = padTo(right[i] ?? "", rightW);
    out.push(`${lime("│")} ${l} ${lime("│")} ${r} ${lime("│")}`);
  }
  out.push(lime("╰" + "─".repeat(total - 2) + "╯"));
  return "\n" + out.join("\n");
}

function stacked(
  version: string,
  art: string[],
  dot: string,
  conn: { connected: boolean; label: string },
): string {
  const lines = [""];
  for (const row of art) lines.push("  " + lime(row));
  lines.push("");
  lines.push("  " + pc.dim(`precision context for AI coding agents · v${version}`));
  lines.push(
    "  " + dot + " " + pc.dim(conn.connected ? `connected · ${conn.label}` : "not connected — run `glint connect`"),
  );
  return lines.join("\n");
}
