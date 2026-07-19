import readline from "node:readline";
import pc from "picocolors";
import prompts from "prompts";

// The session prompt. Type freely to describe a task; the moment you type "/"
// a live dropdown of commands appears and filters as you keep typing. Arrow to
// move, Enter to pick, Esc to dismiss — and you can always just type the whole
// command and hit Enter. Falls back to a plain prompt when stdin isn't a TTY.
//
// Editing works the way a shell does: ←/→ to move, ⌥←/⌥→ by word, Home/End,
// Delete, and ⌃A/⌃E/⌃K/⌃W/⌃U. Text is inserted at the cursor, not appended.

export interface SlashCommand {
  value: string; // "switch"
  title: string; // "/switch"
  description: string;
  arg?: boolean; // needs a follow-up argument (e.g. /plan <task>)
}

const MAX_VISIBLE = 8;
const FILE_HL = "\x1b[38;2;150;220;255m"; // soft cyan — a file Super Terminal located
const DEFAULT_FG = "\x1b[39m";
const FILE_TOKEN = /[\w.-]+(?:\/[\w.-]+)*\.[a-zA-Z0-9]{1,6}/g;

/**
 * Tint filenames that actually exist so you can see Super Terminal found them before you
 * hit enter. Only the written string grows — the visible length is unchanged,
 * so the cursor math (which uses the raw buffer) stays correct.
 */
export function highlightFiles(buf: string, isFile?: (t: string) => boolean): string {
  if (!isFile) return buf;
  return buf.replace(FILE_TOKEN, (m) => (isFile(m) ? `${FILE_HL}${m}${DEFAULT_FG}` : m));
}

/** Commands matching what's typed so far. Empty once an argument is being typed. */
export function filterCommands(buf: string, commands: SlashCommand[]): SlashCommand[] {
  if (!buf.startsWith("/") || buf.includes(" ")) return [];
  const q = buf.slice(1).toLowerCase();
  return commands.filter((c) => c.value.startsWith(q));
}

const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

export interface InputState {
  buf: string;
  pos: number; // caret index into buf
}

/** Start of the word to the left of `i` (skips the gap, then the word). */
export function wordLeft(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1])) j--;
  while (j > 0 && !/\s/.test(s[j - 1])) j--;
  return j;
}

/** End of the word to the right of `i`. */
export function wordRight(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  while (j < s.length && !/\s/.test(s[j])) j++;
  return j;
}

/**
 * Apply one text-editing keypress. Pure, so the editing rules are testable
 * without a terminal. Returns null when the key isn't an editing key, leaving
 * the caller to handle it (Enter, Esc, menu navigation).
 */
export function applyEdit(state: InputState, key: readline.Key, str?: string): InputState | null {
  const { buf, pos } = state;
  const byWord = Boolean(key.meta || key.ctrl); // ⌥← / ⌃← jump a word

  switch (key.name) {
    case "left":
      return { buf, pos: byWord ? wordLeft(buf, pos) : Math.max(0, pos - 1) };
    case "right":
      return { buf, pos: byWord ? wordRight(buf, pos) : Math.min(buf.length, pos + 1) };
    case "home":
      return { buf, pos: 0 };
    case "end":
      return { buf, pos: buf.length };
    case "backspace": {
      if (pos === 0) return { buf, pos };
      const from = byWord ? wordLeft(buf, pos) : pos - 1;
      return { buf: buf.slice(0, from) + buf.slice(pos), pos: from };
    }
    case "delete": {
      if (pos >= buf.length) return { buf, pos };
      return { buf: buf.slice(0, pos) + buf.slice(pos + 1), pos };
    }
    default:
      break;
  }

  if (key.ctrl) {
    if (key.name === "a") return { buf, pos: 0 };
    if (key.name === "e") return { buf, pos: buf.length };
    if (key.name === "k") return { buf: buf.slice(0, pos), pos };
    if (key.name === "u") return { buf: "", pos: 0 };
    if (key.name === "w") {
      const from = wordLeft(buf, pos);
      return { buf: buf.slice(0, from) + buf.slice(pos), pos: from };
    }
  }

  // A printable character goes in at the caret, not at the end.
  if (str && !key.ctrl && !key.meta && str >= " ") {
    return { buf: buf.slice(0, pos) + str + buf.slice(pos), pos: pos + str.length };
  }
  return null;
}

export async function readSessionLine(
  message: string,
  commands: SlashCommand[],
  isFile?: (token: string) => boolean,
): Promise<string | undefined> {
  const out = process.stdout;
  const stdin = process.stdin;
  if (!stdin.isTTY || !out.isTTY) {
    const { next } = await prompts({ type: "text", name: "next", message });
    return next === undefined ? undefined : String(next);
  }

  return new Promise<string | undefined>((resolve) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();

    const prompt = `${pc.dim(message)} ${pc.cyan("›")} `;
    const promptLen = visibleLen(prompt);
    let buf = "";
    let pos = 0;
    let sel = 0;
    let dismissed = false;
    let cursorRow = 0; // row within the drawn block where we left the caret

    const matches = (): SlashCommand[] => (dismissed ? [] : filterCommands(buf, commands));

    const render = (): void => {
      const width = Math.max(20, out.columns ?? 80);
      // Return to the top-left of whatever we drew last time, then wipe it.
      if (cursorRow > 0) out.write(`\x1b[${cursorRow}A`);
      out.write("\r\x1b[0J");

      out.write(prompt + highlightFiles(buf, isFile));
      const list = matches();
      if (sel >= list.length) sel = Math.max(0, list.length - 1);
      const shown = list.slice(0, MAX_VISIBLE);
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i];
        const on = i === sel;
        out.write(`\n${on ? pc.cyan("❯") : " "} ${on ? pc.cyan(pc.bold(c.title)) : c.title}  ${pc.dim(c.description)}`);
      }

      // Place the caret. All arithmetic uses the RAW buffer — the highlight's
      // ANSI codes are zero-width, so they must not enter these sums.
      const endRow = Math.floor((promptLen + buf.length) / width);
      const caret = promptLen + pos;
      const caretRow = Math.floor(caret / width);
      const caretCol = caret % width;

      if (shown.length > 0) out.write(`\x1b[${shown.length}A`); // back up over the menu
      out.write("\r");
      if (endRow > caretRow) out.write(`\x1b[${endRow - caretRow}A`);
      if (caretCol > 0) out.write(`\x1b[${caretCol}C`);
      cursorRow = caretRow;
    };

    const cleanup = (): void => {
      stdin.removeListener("keypress", onKey);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      if (cursorRow > 0) out.write(`\x1b[${cursorRow}A`);
      out.write("\r\x1b[0J"); // wipe the prompt and any menu
    };

    const finish = (value: string | undefined): void => {
      cleanup();
      if (value !== undefined && value !== "") out.write(`${prompt}${value}\n`); // echo what was submitted
      resolve(value);
    };

    const setState = (next: { buf: string; pos: number }): void => {
      const changed = next.buf !== buf;
      buf = next.buf;
      pos = next.pos;
      // Only re-open the menu when the text actually changed — moving the
      // caret shouldn't undo an Esc that dismissed it.
      if (changed) {
        dismissed = false;
        sel = 0;
      }
      render();
    };

    const onKey = (str: string | undefined, key: readline.Key): void => {
      try {
        const list = matches();
        if (key.ctrl && key.name === "c") return finish(undefined);
        if (key.ctrl && key.name === "d" && !buf) return finish(undefined);

        // Esc: close the dropdown if it's open, else clear a half-typed line,
        // else leave. So Esc on an empty prompt quits in one press, and a long
        // prompt is never lost to a stray keystroke.
        if (key.name === "escape") {
          if (list.length > 0) {
            dismissed = true;
            return render();
          }
          if (buf) return setState({ buf: "", pos: 0 });
          return finish(undefined);
        }

        if (key.name === "up" || key.name === "down") {
          if (list.length > 0) sel = (sel + (key.name === "up" ? -1 : 1) + list.length) % list.length;
          return render();
        }
        if (key.name === "tab" || key.name === "return") {
          if (list.length > 0) {
            const c = list[sel];
            if (c.arg) {
              // Let them type the argument; the menu closes.
              return setState({ buf: `${c.title} `, pos: c.title.length + 1 });
            }
            if (key.name === "tab") return setState({ buf: c.title, pos: c.title.length });
            return finish(c.title);
          }
          if (key.name === "tab") return render();
          return finish(buf.trim());
        }

        const next = applyEdit({ buf, pos }, key, str);
        if (next) return setState(next);
      } catch {
        finish(buf.trim()); // never trap the user in a broken input
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}
