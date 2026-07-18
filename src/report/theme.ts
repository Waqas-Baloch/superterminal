import pc from "picocolors";

// Glint's light theme. The brand accent is #0040FF (blue) on a #F3F9FF
// (light) background. On startup Glint asks the terminal to paint the whole
// window in these colors and restores the user's own colors on exit.

export const RESET = "\x1b[0m";

// Truecolor accents (used where the old UI used lime, so it stays visible on a
// light background instead of washing out).
export const ACCENT_FG = "\x1b[38;2;0;64;255m"; // #0040FF text
export const ACCENT_BG = "\x1b[48;2;0;64;255m"; // #0040FF fill (for chips/boxes)
export const ON_ACCENT = "\x1b[38;2;243;249;255m"; // #F3F9FF — light text ON the blue fill
export const ON_ACCENT_DIM = "\x1b[38;2;191;214;255m"; // softer light text on the blue fill

const BG_HEX = "#F3F9FF";
const FG_HEX = "#0040FF";

export const accent = (s: string): string => (pc.isColorSupported ? `${ACCENT_FG}${s}${RESET}` : s);
export const accentBold = (s: string): string => (pc.isColorSupported ? `\x1b[1m${ACCENT_FG}${s}${RESET}` : s);

let applied = false;

/**
 * Paint the terminal window: light-blue background, blue default text, for the
 * whole session — and restore the user's original colors when Glint exits
 * (normal exit or Ctrl-C). Only in a real terminal; a no-op when piped/CI.
 * Terminals that don't support OSC 10/11 quietly ignore it (text still blue).
 */
export function applyTheme(): void {
  if (applied || !process.stdout.isTTY || !pc.isColorSupported) return;
  applied = true;
  process.stdout.write(`\x1b]11;${BG_HEX}\x07\x1b]10;${FG_HEX}\x07`);

  const reset = (): void => {
    try {
      process.stdout.write("\x1b]111\x07\x1b]110\x07"); // reset bg + fg to terminal defaults
    } catch {
      // stream already closed — nothing to do
    }
  };
  process.on("exit", reset);
  // A hard Ctrl-C (outside an interactive prompt) arrives as a signal, and the
  // 'exit' event won't fire — so reset here too, then leave.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      reset();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}
