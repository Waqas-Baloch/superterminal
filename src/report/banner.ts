import pc from "picocolors";
import { resolveAuth } from "../util/globalConfig";
import { AGENT_CLIS } from "../claude/agentCli";

const LIME = "\x1b[38;5;154m";
const DIM_LIME = "\x1b[38;5;107m";
const RESET = "\x1b[0m";
const on = pc.isColorSupported;
const lime = (s: string) => (on ? `${LIME}${s}${RESET}` : s);
const dimLime = (s: string) => (on ? `${DIM_LIME}${s}${RESET}` : s);

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

function wordmark(word: string): string[] {
  const glyphs = [...word].map((c) => GLYPHS[c]).filter(Boolean);
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const line = glyphs
      .map((g) => [...g[r]].map((px) => (px === "#" ? PIXEL + PIXEL : "  ")).join(""))
      .join("  "); // one blank pixel column between letters
    rows.push(line);
  }
  return rows;
}

async function connectionLine(): Promise<string> {
  const auth = await resolveAuth();
  if (!auth) return dimLime("○ not connected") + pc.dim("  — run `glint connect`");
  const label =
    auth.mode === "agent-cli"
      ? AGENT_CLIS[auth.agent].title
      : auth.mode === "oauth"
        ? "Anthropic (browser login)"
        : "Anthropic API";
  return lime("● ") + pc.dim(`connected · ${label}`);
}

/** Full welcome header — the pixel wordmark plus status, shown on a bare `glint` and at session start. */
export async function renderHeader(version: string): Promise<string> {
  const lines: string[] = [""];
  for (const row of wordmark("glint")) lines.push("  " + lime(row));
  lines.push("");
  lines.push("  " + pc.dim(`precision context for AI coding agents · v${version}`));
  lines.push("  " + (await connectionLine()));
  lines.push("");
  return lines.join("\n");
}
