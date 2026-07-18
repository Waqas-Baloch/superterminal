import readline from "node:readline";
import pc from "picocolors";
import prompts from "prompts";

// The session prompt. Type freely to describe a task; the moment you type "/"
// a live dropdown of commands appears and filters as you keep typing. Arrow to
// move, Enter to pick, Esc to dismiss — and you can always just type the whole
// command and hit Enter. Falls back to a plain prompt when stdin isn't a TTY.

export interface SlashCommand {
  value: string; // "switch"
  title: string; // "/switch"
  description: string;
  arg?: boolean; // needs a follow-up argument (e.g. /plan <task>)
}

const MAX_VISIBLE = 8;

/** Commands matching what's typed so far. Empty once an argument is being typed. */
export function filterCommands(buf: string, commands: SlashCommand[]): SlashCommand[] {
  if (!buf.startsWith("/") || buf.includes(" ")) return [];
  const q = buf.slice(1).toLowerCase();
  return commands.filter((c) => c.value.startsWith(q));
}

const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

export async function readSessionLine(message: string, commands: SlashCommand[]): Promise<string | undefined> {
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
    let sel = 0;
    let dismissed = false;
    let inputRows = 1; // screen rows the prompt+input occupied on the last render

    const matches = (): SlashCommand[] => (dismissed ? [] : filterCommands(buf, commands));

    const render = (): void => {
      const width = Math.max(20, out.columns ?? 80);
      // Return to the top-left of whatever we drew last time, then wipe it.
      if (inputRows > 1) out.write(`\x1b[${inputRows - 1}A`);
      out.write("\r\x1b[0J");

      out.write(prompt + buf);
      const list = matches();
      if (sel >= list.length) sel = Math.max(0, list.length - 1);
      const shown = list.slice(0, MAX_VISIBLE);
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i];
        const on = i === sel;
        out.write(`\n${on ? pc.cyan("❯") : " "} ${on ? pc.cyan(pc.bold(c.title)) : c.title}  ${pc.dim(c.description)}`);
      }

      // Put the cursor back at the end of the typed text.
      const total = promptLen + buf.length;
      inputRows = Math.max(1, Math.ceil((total + 1) / width));
      if (shown.length > 0) out.write(`\x1b[${shown.length}A`);
      const endCol = total % width;
      out.write("\r");
      if (endCol > 0) out.write(`\x1b[${endCol}C`);
    };

    const cleanup = (): void => {
      stdin.removeListener("keypress", onKey);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      if (inputRows > 1) out.write(`\x1b[${inputRows - 1}A`);
      out.write("\r\x1b[0J"); // wipe the prompt and any menu
    };

    const finish = (value: string | undefined): void => {
      cleanup();
      if (value !== undefined && value !== "") out.write(`${prompt}${value}\n`); // echo what was submitted
      resolve(value);
    };

    const onKey = (str: string | undefined, key: readline.Key): void => {
      try {
        const list = matches();
        if (key.ctrl && key.name === "c") return finish(undefined);
        if (key.ctrl && key.name === "d" && !buf) return finish(undefined);
        if (key.ctrl && key.name === "u") {
          buf = "";
          dismissed = false;
          sel = 0;
          return render();
        }
        if (key.name === "escape") {
          dismissed = true;
          return render();
        }
        if (key.name === "up" || key.name === "down") {
          if (list.length > 0) sel = (sel + (key.name === "up" ? -1 : 1) + list.length) % list.length;
          return render();
        }
        if (key.name === "tab" || key.name === "return") {
          if (list.length > 0) {
            const c = list[sel];
            if (c.arg) {
              buf = `${c.title} `; // let them type the argument; the menu closes
              sel = 0;
              return render();
            }
            if (key.name === "tab") {
              buf = c.title;
              return render();
            }
            return finish(c.title);
          }
          if (key.name === "tab") return render();
          return finish(buf.trim());
        }
        if (key.name === "backspace") {
          buf = buf.slice(0, -1);
          dismissed = false;
          sel = 0;
          return render();
        }
        if (str && !key.ctrl && !key.meta && str >= " ") {
          buf += str;
          dismissed = false;
          sel = 0;
          return render();
        }
      } catch {
        finish(buf.trim()); // never trap the user in a broken input
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}
