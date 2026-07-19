import { promises as fs } from "node:fs";
import nodePath from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { RepoIndex } from "../core/indexer";
import { ALL_STATE_DIRS, stateDir } from "../util/paths";

const MAX_READ_CHARS = 60_000;
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ...ALL_STATE_DIRS]);
const BLOCKED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);

/**
 * Staging area for Claude's edits. Nothing touches disk until apply();
 * apply() backs up originals to <state>/backup/<runId>/ first.
 */
export class EditStage {
  private staged = new Map<string, string>();
  private createdPaths = new Set<string>();
  private backedUp = new Set<string>();
  private appliedPaths = new Set<string>();

  constructor(private root: string) {}

  private normalize(rel: string): string {
    return rel.replace(/^\/+/, "").replaceAll("\\", "/");
  }

  private safeResolve(rel: string): string {
    const key = this.normalize(rel);
    const abs = nodePath.resolve(this.root, key);
    if (abs !== this.root && !abs.startsWith(this.root + nodePath.sep)) {
      throw new Error(`Path escapes the repository: ${rel}`);
    }
    const parts = key.split("/");
    if (parts.some((p) => BLOCKED_SEGMENTS.has(p)) || BLOCKED_FILES.has(parts[parts.length - 1])) {
      throw new Error(`Path is not editable: ${rel}`);
    }
    return abs;
  }

  async read(rel: string): Promise<string> {
    const key = this.normalize(rel);
    if (this.staged.has(key)) return this.staged.get(key)!;
    return fs.readFile(this.safeResolve(key), "utf8");
  }

  async strReplace(rel: string, oldStr: string, newStr: string): Promise<void> {
    if (!oldStr) throw new Error("old_string must not be empty");
    const current = await this.read(rel);
    const count = current.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${rel} — read the file and retry with an exact snippet`);
    if (count > 1) throw new Error(`old_string appears ${count} times in ${rel} — provide a longer, unique snippet`);
    this.staged.set(this.normalize(rel), current.replace(oldStr, newStr));
  }

  async write(rel: string, content: string): Promise<void> {
    const key = this.normalize(rel);
    const abs = this.safeResolve(key);
    if (!this.staged.has(key) && !this.appliedPaths.has(key)) {
      try {
        await fs.access(abs);
      } catch {
        this.createdPaths.add(key);
      }
    }
    this.staged.set(key, content);
  }

  /** Paths staged but not yet applied. */
  get touched(): string[] {
    return [...this.staged.keys()];
  }

  /** Every path applied to disk over the lifetime of this stage. */
  get allTouched(): string[] {
    return [...this.appliedPaths];
  }

  wasCreated(rel: string): boolean {
    return this.createdPaths.has(this.normalize(rel));
  }

  async apply(runId: string): Promise<{ modified: string[]; created: string[] }> {
    const backupDir = nodePath.join(stateDir(this.root), "backup", runId);
    const filesDir = nodePath.join(backupDir, "files");
    const modified: string[] = [];
    const created: string[] = [];

    for (const [key, content] of this.staged) {
      const abs = this.safeResolve(key);
      const isCreated = this.createdPaths.has(key);
      if (!isCreated && !this.backedUp.has(key)) {
        const backupPath = nodePath.join(filesDir, key);
        await fs.mkdir(nodePath.dirname(backupPath), { recursive: true });
        await fs.copyFile(abs, backupPath);
        this.backedUp.add(key);
      }
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      this.appliedPaths.add(key);
      (isCreated ? created : modified).push(key);
    }

    if (this.staged.size > 0 && this.createdPaths.size > 0) {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(nodePath.join(backupDir, "created.json"), JSON.stringify([...this.createdPaths], null, 2));
    }

    this.staged.clear();
    return { modified, created };
  }
}

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read a file from the repository. Call this whenever you need the full content of a file that the manifest only shows as a signature, or any other repo file you need to inspect before editing.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. src/components/Button.tsx" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description:
      "List repository file paths. Call this when you are unsure where something lives or whether a file exists. Optionally filter by a substring of the path.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Case-insensitive substring to filter paths, e.g. 'components/'" },
      },
      required: [],
    },
  },
  {
    name: "str_replace",
    description:
      "Edit an existing file by replacing one exact snippet. old_string must appear exactly once in the file — include enough surrounding lines to make it unique. This is the preferred way to modify existing files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path of the file to edit" },
        old_string: { type: "string", description: "Exact text to replace (must be unique in the file)" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file (or fully overwrite one you have already read) with the given content. For edits to existing files, prefer str_replace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path for the file" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
];

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export async function executeTool(
  stage: EditStage,
  index: RepoIndex,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, string>;
  try {
    switch (name) {
      case "read_file": {
        const text = await stage.read(requireArg(args, "path"));
        return { text: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated)` : text };
      }
      case "list_files": {
        const filter = (args.filter ?? "").toLowerCase();
        const paths = index.files.map((f) => f.path).filter((p) => p.toLowerCase().includes(filter));
        return { text: paths.slice(0, 500).join("\n") || "(no matches)" };
      }
      case "str_replace": {
        await stage.strReplace(requireArg(args, "path"), requireArg(args, "old_string"), args.new_string ?? "");
        return { text: `Edited ${args.path}` };
      }
      case "write_file": {
        await stage.write(requireArg(args, "path"), args.content ?? "");
        return { text: `Wrote ${args.path}` };
      }
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function requireArg(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required argument: ${key}`);
  return value;
}
