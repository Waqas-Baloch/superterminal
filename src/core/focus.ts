export interface Excerpt {
  start: number; // 0-based, inclusive
  end: number;
  text: string;
}

export interface FocusResult {
  excerpts: Excerpt[];
  shownLines: number;
  totalLines: number;
}

const CONTEXT_LINES = 8;
const SNAP_RANGE = 6; // how far to look for a blank-line boundary
const MAX_COVERAGE = 0.6; // beyond this, excerpting saves nothing — send whole file

/**
 * Precision targeting: keep only the regions of a file that mention the task
 * terms, each with surrounding context, snapped outward to blank-line
 * boundaries so rules/blocks/sections aren't cut in half.
 *
 * Returns null when excerpting is pointless: no term hits (file was selected
 * structurally — send it whole) or hits cover most of the file anyway.
 */
export function focusContent(content: string, terms: string[]): FocusResult | null {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const lower = lines.map((l) => l.toLowerCase());
  const candidates = [...new Set(terms.map((t) => t.toLowerCase()))].filter((t) => t.length >= 3);
  if (candidates.length === 0) return null;

  // Per-file discrimination: a term that hits a large share of lines is
  // boilerplate IN THIS FILE (e.g. "section" matching every <section> tag)
  // and would defeat excerpting. Keep only terms that actually pinpoint.
  const boilerplateThreshold = Math.max(4, totalLines * 0.25);
  const needles = candidates.filter((t) => {
    const hits = lower.reduce((n, l) => n + (l.includes(t) ? 1 : 0), 0);
    return hits > 0 && hits <= boilerplateThreshold;
  });
  if (needles.length === 0) return null;

  const hitLines: number[] = [];
  for (let i = 0; i < totalLines; i++) {
    if (needles.some((t) => lower[i].includes(t))) hitLines.push(i);
  }
  if (hitLines.length === 0) return null;

  let windows: [number, number][] = [];
  for (const hit of hitLines) {
    const start = Math.max(0, hit - CONTEXT_LINES);
    const end = Math.min(totalLines - 1, hit + CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 2) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }

  for (const w of windows) {
    w[0] = snapUp(lines, w[0]);
    w[1] = snapDown(lines, w[1]);
  }
  windows = mergeWindows(windows);

  const shownLines = windows.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
  if (shownLines / totalLines > MAX_COVERAGE) return null;

  return {
    excerpts: windows.map(([start, end]) => ({
      start,
      end,
      text: lines.slice(start, end + 1).join("\n"),
    })),
    shownLines,
    totalLines,
  };
}

function snapUp(lines: string[], start: number): number {
  for (let i = start; i >= Math.max(0, start - SNAP_RANGE); i--) {
    if (i === 0) return 0;
    if (lines[i - 1].trim() === "") return i;
  }
  return start;
}

function snapDown(lines: string[], end: number): number {
  const max = lines.length - 1;
  for (let i = end; i <= Math.min(max, end + SNAP_RANGE); i++) {
    if (i === max) return max;
    if (lines[i + 1].trim() === "") return i;
  }
  return end;
}

function mergeWindows(windows: [number, number][]): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}
