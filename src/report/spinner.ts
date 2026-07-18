import ora, { type Ora } from "ora";
import pc from "picocolors";

// Glint's loading animation: three lime dots riding a travelling wave.
//
// A terminal line has no sub-pixel vertical space, so each dot lives in its own
// cell and moves through the four vertical positions of a single braille column
// (⠁ top → ⡀ bottom). Height comes from a sine wave, which *is* ease-in-out:
// its velocity falls to zero at the peaks, so the dots naturally slow at the
// top and bottom of each bob instead of snapping. Phase-offsetting each dot by
// a third of a cycle makes the wave travel left→right.

const LIME = "\x1b[38;2;243;249;255m"; // brand light #F3F9FF on the blue bg (name kept)
const RESET = "\x1b[0m";
const lime = (s: string) => (pc.isColorSupported ? `${LIME}${s}${RESET}` : s);

const LEVELS = ["⠁", "⠂", "⠄", "⡀"]; // top → bottom, one braille column
const DOTS = 3;
// 12 frames is the sweet spot for a 4-level column: every step moves exactly
// one level (never jumps), and a dot dwells at most 3 frames (~270ms) at the
// top/bottom of its arc — enough to read as easing, not as sticking. Fewer
// frames gets twitchy; more parks the dots at the extremes.
const FRAMES = 12;
const PHASE = (2 * Math.PI) / 3; // each dot trails the previous by a third of a cycle
const INTERVAL = 90; // ms/frame → ~1.1s per wave

function buildFrames(): string[] {
  const frames: string[] = [];
  for (let t = 0; t < FRAMES; t++) {
    let row = "";
    for (let i = 0; i < DOTS; i++) {
      const y = Math.sin((2 * Math.PI * t) / FRAMES - i * PHASE); // 1 = top, −1 = bottom
      row += LEVELS[Math.round(((1 - y) / 2) * (LEVELS.length - 1))];
    }
    frames.push(lime(row));
  }
  return frames;
}

export const glintSpinner = { interval: INTERVAL, frames: buildFrames() };

/** ora, wearing Glint's wave. Use instead of calling ora() directly. */
export function spin(text: string): Ora {
  return ora({ text, spinner: glintSpinner });
}

// ── The pixel wave ──────────────────────────────────────────────────────────
//
// Same motion, but the dots are the wordmark's own pixel: `██`, exactly the
// tittle of the `i` in the logo. A full block fills its cell, so it cannot move
// inside one line — but the logo is a pixel grid drawn across rows, so the
// animation is too. Half-blocks buy half-row resolution: a dot sitting between
// rows renders as `▄▄` on the upper row and `▀▀` on the lower, which stack into
// one full-height block straddling the boundary. Three rows → five positions.

const PIXEL_ROWS = 3;
const V_STEPS = 4; // 0..4 → five half-row positions

function pixelFrame(t: number): string[] {
  const rows: string[][] = Array.from({ length: PIXEL_ROWS }, () => Array.from({ length: DOTS }, () => "  "));
  for (let i = 0; i < DOTS; i++) {
    const y = Math.sin((2 * Math.PI * t) / FRAMES - i * PHASE);
    const p = Math.round(((1 - y) / 2) * V_STEPS);
    if (p % 2 === 0) {
      rows[p / 2][i] = "██"; // sits on a row
    } else {
      rows[(p - 1) / 2][i] = "▄▄"; // straddles two rows
      rows[(p + 1) / 2][i] = "▀▀";
    }
  }
  return rows.map((r) => r.join(" "));
}

export interface Wave {
  stop(): void;
}

/**
 * A three-row wave of logo pixels, for the long wait while the agent thinks.
 * Degrades to a single printed line when stdout isn't a terminal.
 */
export function pixelWave(label: string): Wave {
  const out = process.stdout;
  if (!out.isTTY) {
    out.write(`${label}\n`);
    return { stop: () => {} };
  }

  let t = 0;
  let drawn = false;
  const draw = (): void => {
    const grid = pixelFrame(t++);
    if (drawn) out.write(`\x1b[${PIXEL_ROWS}A`); // back to the top of the grid
    drawn = true;
    for (let r = 0; r < PIXEL_ROWS; r++) {
      const tail = r === 1 ? `  ${pc.dim(label)}` : "";
      out.write(`\x1b[2K  ${lime(grid[r])}${tail}\n`);
    }
  };

  out.write("\x1b[?25l"); // hide cursor
  draw();
  const timer = setInterval(draw, INTERVAL);
  timer.unref?.(); // never hold the process open on our account

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      out.write(`\x1b[${PIXEL_ROWS}A`);
      for (let r = 0; r < PIXEL_ROWS; r++) out.write("\x1b[2K\n"); // wipe the grid
      out.write(`\x1b[${PIXEL_ROWS}A\x1b[?25h`); // rewind, show cursor
    },
  };
}
