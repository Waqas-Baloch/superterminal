import { diffLines } from "diff";

// Surgical revert: undo only the part of an edit that went out of scope, and
// keep the rest. When the agent changes both identical buttons but you asked it
// to keep the footer one, this rebuilds the file with the footer restored to
// its original and the nav change left intact — instead of `glint revert`
// throwing away the whole run.

export interface SurgicalResult {
  content: string;
  reverted: number; // how many hunks were restored to the original
}

/**
 * Rebuild `after`, but restore the hunks overlapping `keepLines` back to
 * `before`. `keepLines` are 1-based line numbers in the ORIGINAL (before) file —
 * the locations the user said to leave alone. A hunk that touched one of those
 * lines is reverted; every other hunk (the intended change) is preserved.
 *
 * Degrades safely: if the agent rewrote the whole file as one hunk, that hunk
 * overlaps the kept line and the file reverts wholesale — never a broken merge.
 */
export function surgicalRevert(before: string, after: string, keepLines: number[]): SurgicalResult {
  const parts = diffLines(before, after);
  const out: string[] = [];
  let bLine = 1; // current line in the BEFORE file
  let reverted = 0;

  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    const lines = p.count ?? countLines(p.value);

    if (!p.added && !p.removed) {
      out.push(p.value); // unchanged context
      bLine += lines;
      continue;
    }

    if (p.removed) {
      const segEnd = bLine + lines - 1;
      const overlaps = keepLines.some((l) => l >= bLine && l <= segEnd);
      const next = parts[k + 1];
      if (overlaps) {
        out.push(p.value); // restore the original lines the user wanted kept
        reverted++;
        if (next?.added) k++; // and drop the agent's replacement for them
      }
      // else: an intended removal — leave it removed (emit nothing)
      bLine = segEnd + 1;
    } else {
      out.push(p.value); // an intended addition, or the new side of a change we kept
    }
  }

  return { content: out.join(""), reverted };
}

function countLines(value: string): number {
  return (value.match(/\n/g) ?? []).length + (value.endsWith("\n") ? 0 : 1);
}
