import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { execa } from "execa";

/**
 * Open content in the user's editor and return the edited result. Uses
 * $VISUAL / $EDITOR, falling back to nano (macOS/Linux) or notepad (Windows).
 * Throws if no editor can be launched — the caller decides how to recover.
 */
export async function openInEditor(content: string, ext = "md"): Promise<string> {
  const file = nodePath.join(os.tmpdir(), `glint-${randomBytes(6).toString("hex")}.${ext}`);
  await fs.writeFile(file, content);
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
  try {
    const result = await execa(editor, [file], { stdio: "inherit", reject: false });
    if (result.exitCode !== 0 && result.failed) {
      throw new Error(`Editor "${editor}" could not be launched`);
    }
    return await fs.readFile(file, "utf8");
  } finally {
    await fs.rm(file, { force: true });
  }
}
