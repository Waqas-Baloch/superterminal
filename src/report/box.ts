import pc from "picocolors";
import { RESET, ACCENT_FG, ACCENT_BG, ON_ACCENT, ON_ACCENT_DIM, accent } from "./theme";

const BLUE_FG = ACCENT_FG; // #0040FF — border/accent
const BLUE_BG = ACCENT_BG; // #0040FF — chip fill
const INK = ON_ACCENT; // light text on the blue fill
const MID = ON_ACCENT_DIM; // softer light text on the blue fill
const BOLD = "\x1b[1m";
const NO_BOLD = "\x1b[22m";

// Kept these names so importers don't churn; both are the brand blue now.
export const lime = accent;
export const darkGreen = accent;

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

  out.push(`${BLUE_FG}▗${"▄".repeat(width - 2)}▖${RESET}`);
  out.push(`${BLUE_BG}${INK}  ${BOLD}${pad(fit(title, content), content)}${NO_BOLD}  ${RESET}`);

  for (const row of rows) {
    const { left, gap, right } = compose(row, content);
    const body =
      row.kind === "sub"
        ? `${MID}${left}${gap}${right}`
        : `${INK}${left}${gap}${MID}${right}${INK}`;
    out.push(`${BLUE_BG}  ${body}  ${RESET}`);
  }

  out.push(`${BLUE_FG}▝${"▀".repeat(width - 2)}▘${RESET}`);
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
