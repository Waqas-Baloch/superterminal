import pc from "picocolors";

const RESET = "\x1b[0m";
const LIME_FG = "\x1b[38;5;154m";
const LIME_BG = "\x1b[48;5;154m";
const INK = "\x1b[38;5;22m"; // darkest green — main text on lime fill
const MID = "\x1b[38;5;28m"; // medium green — supporting text on lime fill
const BOLD = "\x1b[1m";
const NO_BOLD = "\x1b[22m";

export const lime = (s: string) => (pc.isColorSupported ? `${LIME_FG}${s}${RESET}` : s);
export const darkGreen = (s: string) => (pc.isColorSupported ? `${MID}${s}${RESET}` : s);

export interface BoxRow {
  left: string;
  right?: string;
  kind?: "main" | "sub"; // main = file paths, sub = supporting detail
}

export const BOX_WIDTH = 68;
export type BoxMode = "auto" | "filled" | "outline";

/**
 * Solid lime box with dark green text. Corners use quadrant blocks (▗▖▝▘) —
 * the roundest treatment a character terminal can draw. Terminals without
 * color support fall back to a plain outline box.
 */
export function renderBox(title: string, rows: BoxRow[], width = BOX_WIDTH, mode: BoxMode = "auto"): string[] {
  const filled = mode === "filled" || (mode === "auto" && pc.isColorSupported);
  return filled ? renderFilled(title, rows, width) : renderOutline(title, rows, width);
}

function renderFilled(title: string, rows: BoxRow[], width: number): string[] {
  const content = width - 4;
  const out: string[] = [];

  out.push(`${LIME_FG}▗${"▄".repeat(width - 2)}▖${RESET}`);
  out.push(`${LIME_BG}${INK}  ${BOLD}${pad(fit(title, content), content)}${NO_BOLD}  ${RESET}`);

  for (const row of rows) {
    const { left, gap, right } = compose(row, content);
    const body =
      row.kind === "sub"
        ? `${MID}${left}${gap}${right}`
        : `${INK}${left}${gap}${MID}${right}${INK}`;
    out.push(`${LIME_BG}  ${body}  ${RESET}`);
  }

  out.push(`${LIME_FG}▝${"▀".repeat(width - 2)}▘${RESET}`);
  return out;
}

function renderOutline(title: string, rows: BoxRow[], width: number): string[] {
  const content = width - 4;
  const fill = Math.max(1, width - 5 - title.length);
  const out: string[] = [];

  out.push(lime(`╭─ ${title} ${"─".repeat(fill)}╮`));
  for (const row of rows) {
    const { left, gap, right } = compose(row, content);
    const body =
      row.kind === "sub"
        ? pc.dim(`${left}${gap}${right}`)
        : `${darkGreen(left)}${gap}${pc.dim(right)}`;
    out.push(`${lime("│")} ${body} ${lime("│")}`);
  }
  out.push(lime(`╰${"─".repeat(width - 2)}╯`));
  return out;
}

function compose(row: BoxRow, content: number): { left: string; gap: string; right: string } {
  const right = row.right ?? "";
  const maxLeft = content - (right ? right.length + 1 : 0);
  const left = fit(row.left, maxLeft);
  const gap = " ".repeat(Math.max(0, content - left.length - right.length));
  return { left, gap, right };
}

function fit(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…${s.slice(s.length - (max - 1))}`;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}
