import pc from "picocolors";

// A single status line that updates in place — the agent's current action —
// with a subtle shimmer (a soft bright band sweeping left→right over faded
// text). Each new step replaces the previous one, so the steps never stack.

const RESET = "\x1b[0m";
const BASE = "\x1b[38;2;168;192;232m"; // faded light — the resting text
const GLOW = "\x1b[38;2;255;255;255m"; // bright — the shimmer highlight
const GLOW2 = "\x1b[38;2;214;228;255m"; // soft edge of the highlight
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[2K";
const INTERVAL = 70;
const GAP = 12; // extra travel so the glow fully exits before re-entering

export interface StatusLine {
  set(text: string): void;
  stop(): void;
}

export function statusLine(): StatusLine {
  const out = process.stdout;
  // No TTY / no color (CI, pipes): just print each step once, plainly, so logs
  // still record what happened.
  if (!out.isTTY || !pc.isColorSupported) {
    return { set: (t) => (t ? void out.write(`${t}\n`) : undefined), stop: () => {} };
  }

  let text = "";
  let pos = 0;
  let active = false;
  let timer: NodeJS.Timeout | null = null;

  const draw = (): void => {
    if (!text) return;
    out.write(`${CLEAR}${shimmer(text, pos)}`);
    pos = (pos + 1) % (text.length + GAP);
  };

  return {
    set(t: string) {
      text = t;
      pos = 0;
      if (!active) {
        active = true;
        out.write(HIDE);
        timer = setInterval(draw, INTERVAL);
        timer.unref?.();
      }
      draw();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (active) out.write(`${CLEAR}${SHOW}`);
      active = false;
    },
  };
}

function shimmer(text: string, pos: number): string {
  let s = "";
  for (let i = 0; i < text.length; i++) {
    const d = Math.abs(pos - i);
    const color = d <= 1 ? GLOW : d <= 3 ? GLOW2 : BASE;
    s += `${color}${text[i]}${RESET}`;
  }
  return s;
}
