import { structuredPatch } from "diff";
import pc from "picocolors";

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  rendered: string;
  created: boolean;
}

const MAX_RENDERED_LINES = 250;

export function renderFileDiff(path: string, before: string, after: string, created: boolean): FileDiff {
  const patch = structuredPatch(path, path, before, after, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  const lines: string[] = [];

  for (const hunk of patch.hunks) {
    lines.push(pc.cyan(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added++;
        lines.push(pc.green(line));
      } else if (line.startsWith("-")) {
        removed++;
        lines.push(pc.red(line));
      } else {
        lines.push(pc.dim(line));
      }
    }
  }

  const rendered =
    lines.length > MAX_RENDERED_LINES
      ? [...lines.slice(0, MAX_RENDERED_LINES), pc.dim(`… (${lines.length - MAX_RENDERED_LINES} more diff lines)`)].join("\n")
      : lines.join("\n");

  return { path, added, removed, rendered, created };
}
