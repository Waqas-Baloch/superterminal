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

const LIME = "\x1b[38;5;154m";
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
