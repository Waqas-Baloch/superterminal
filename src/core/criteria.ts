// Acceptance criteria: the PM's definition of "done", parsed from wherever it
// already lives — the task text (pasted ticket), product.md, context, or rules.
// Each criterion is checked individually by the Second Opinion reviewer, so the
// answer a PM gets is "2 of 3 met, here's the gap", not a pass/fail shrug.

const HEADING_RE = /^#{0,6}\s*acceptance criteria:?\s*$/im;
// EARS-style requirement lines read as criteria even without a heading.
const EARS_RE = /^(when|while|if|where)\b.+\b(shall|must|should)\b/i;

/** Pull individual criteria out of free text. Order preserved, deduped. */
export function parseCriteria(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const c = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^\[[ xX]\]\s*/, "")
      .trim();
    const key = c.toLowerCase();
    if (c.length >= 8 && !seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  };

  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (HEADING_RE.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // The section ends at the next heading or after a blank line following items.
      if (/^#{1,6}\s/.test(line) || (/^\s*$/.test(line) && out.length > 0)) {
        inSection = false;
        continue;
      }
      if (/^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])/.test(line)) push(line);
      continue;
    }
    // Outside a section: checkbox items and EARS lines still count.
    if (/^\s*[-*]\s*\[[ xX]\]/.test(line)) push(line);
    else if (EARS_RE.test(line.trim())) push(line);
  }
  return out.slice(0, 20); // a review against 300 criteria is a review of none
}

export type CriterionStatus = "met" | "not_met" | "unknown";

export interface CriterionVerdict {
  index: number; // 1-based, matching the numbered list shown to the reviewer
  status: CriterionStatus;
  note: string;
}

/** Parse "AC1: MET — note" lines from a reviewer's reply. Missing numbers become unknown. */
export function parseCriteriaVerdicts(text: string, count: number): CriterionVerdict[] {
  const found = new Map<number, CriterionVerdict>();
  // Separator class is horizontal-only: \s would match the newline and let one
  // AC line's match swallow the next line whole.
  for (const m of text.matchAll(/^[ \t]*(?:[-*•][ \t]*)?AC[ \t]*(\d+)[ \t]*:[ \t]*(MET|NOT[ _-]?MET|UNKNOWN)\b[ \t—:-]*(.*)$/gim)) {
    const index = Number(m[1]);
    if (index < 1 || index > count || found.has(index)) continue;
    const raw = m[2].toUpperCase().replace(/[ _-]/g, "");
    const status: CriterionStatus = raw === "MET" ? "met" : raw === "NOTMET" ? "not_met" : "unknown";
    found.set(index, { index, status, note: m[3].trim().slice(0, 200) });
  }
  const out: CriterionVerdict[] = [];
  for (let i = 1; i <= count; i++) {
    // A criterion the reviewer didn't address is UNKNOWN — silence is never "met".
    out.push(found.get(i) ?? { index: i, status: "unknown", note: "not addressed by the reviewer" });
  }
  return out;
}

export const statusMark = (s: CriterionStatus): string => (s === "met" ? "✓" : s === "not_met" ? "✗" : "○");
