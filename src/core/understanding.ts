// Glint Context Understanding & Clarification layer.
//
// This sits ON TOP of the ranking system (src/core/ranking/*), which stays the
// authority on "what is relevant." The ranking answers relevance; this layer
// answers "what is safely resolvable" and decides, per the spec, one of four
// outcomes: auto-execute (Green), infer style and execute (Yellow), ask one
// focused question (Orange), or block a risky ambiguous edit (Red).
//
// It is pure and offline: every candidate shown to the user is a real element
// scanned out of the selected files. No prompts/UI live here — the Clarification
// Composer that turns a report into an interactive question lives in clarify.ts.

import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { STOPWORDS, type Selection } from "./selector";

export const UI_FILE = /\.(html?|jsx|tsx)$/;
export const STYLE_FILE = /\.(css|scss)$/;

// ─────────────────────────────── Intent frame ───────────────────────────────

export type ActionType =
  | "remove"
  | "rename"
  | "restyle"
  | "move"
  | "hide"
  | "duplicate"
  | "connect"
  | "add"
  | "other";

export type RiskProfile = "destructive" | "layout" | "style" | "additive" | "other";

export interface IntentFrame {
  action: ActionType;
  risk: RiskProfile;
  modifiers: string[]; // primary, top, hero, first, only, mobile, …
  scopeHints: string[]; // navbar, footer, header, page names — words that pin a section
  quotedTargets: string[]; // exact things the user named in quotes
  raw: string;
}

// Order matters: the first matching action wins, and destructive verbs are
// listed first so a "remove … and restyle …" request is treated as destructive.
const ACTION_WORDS: [ActionType, RegExp][] = [
  ["remove", /\b(remove|delete|get\s+rid\s+of|drop|strip|take\s+out|kill|erase)\b/i],
  ["hide", /\b(hide|conceal|collapse)\b/i],
  ["rename", /\b(rename|reword|relabel|change\s+the\s+(text|label|copy|wording)|change\s+.*\s+to\s+say)\b/i],
  ["move", /\b(move|reorder|relocate|reposition|swap)\b/i],
  ["restyle", /\b(restyle|recolou?r|colou?r|style|font|background|padding|margin|spacing|rounded|shadow|border|align|bigger|smaller|bold|nicer|prettier|cleaner|sleeker?|polished|modern|fancy|beautiful|stylish)\b/i],
  ["duplicate", /\b(duplicate|clone)\b/i],
  ["connect", /\b(connect|wire\s+up|hook\s+up|integrate|link\s+.*\s+to)\b/i],
  ["add", /\b(add|create|insert|introduce|build|new)\b/i],
];

const DESTRUCTIVE_ACTIONS: ActionType[] = ["remove", "hide", "move"];
const MODIFIER_WORDS = [
  "primary", "secondary", "top", "bottom", "hero", "first", "last", "only",
  "main", "mobile", "desktop", "left", "right", "sidebar",
];
const SCOPE_WORDS = [
  "navbar", "nav", "header", "footer", "sidebar", "hero", "banner", "modal",
  "dialog", "menu", "page", "home", "homepage", "dashboard", "section", "aside",
];
const QUOTE_RE = /["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/g;

export function buildIntentFrame(task: string): IntentFrame {
  const lower = task.toLowerCase();
  let action: ActionType = "other";
  for (const [a, re] of ACTION_WORDS) {
    if (re.test(lower)) {
      action = a;
      break;
    }
  }

  let risk: RiskProfile = "other";
  if (DESTRUCTIVE_ACTIONS.includes(action)) risk = "destructive";
  else if (action === "restyle") risk = "style";
  else if (action === "add") risk = "additive";
  if (/\b(layout|grid|flex|position|column|row|reflow)\b/.test(lower) && risk !== "destructive") risk = "layout";

  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  return {
    action,
    risk,
    modifiers: MODIFIER_WORDS.filter((m) => words.has(m)),
    scopeHints: SCOPE_WORDS.filter((s) => words.has(s)),
    quotedTargets: [...task.matchAll(QUOTE_RE)].map((m) => m[1].trim()).filter(Boolean),
    raw: task,
  };
}

// ─────────────────────────── Candidate instances ────────────────────────────

export interface Instance {
  file: string;
  line: number;
  landmark: string; // enclosing nav/header/footer/section#id — tells copies apart
  text: string; // visible copy or the matched line
  value: string; // stable id compiled into the refinement, e.g. `index.html:8 · in <footer>`
  label: string; // human line for the picker
}

export interface DuplicateFinding {
  phrase: string;
  instances: Instance[];
  crossFile: boolean; // occurrences span more than one file
  crossSection: boolean; // occurrences span more than one landmark (nav vs footer)
}

export interface AmbiguityReport {
  duplicate: DuplicateFinding | null;
  styleUnderspecified: boolean; // restyle request with no concrete color/size/etc.
}

// Visible text between any two tags — the copy a user is likely to name. This
// is deliberately tag-agnostic and spans lines, so it catches multi-line
// elements and React components (`<Button>…</Button>`, `<CustomCTA>…`) alike,
// not just single-line HTML. `{…}` is excluded so JSX expressions and CSS/JS
// braces aren't captured as literal copy.
const TEXT_NODE_RE = />([^<>{}]{2,80})</g;
// Reject captures that look like code rather than visible copy.
const CODEY_RE = /;|=>|\/\/|\breturn\b|\bfunction\b|\bconst\b/;
const LANDMARK_RE = /<(nav|header|footer|main|aside|section|form|dialog|table)\b([^>]*)>/i;
const STYLE_VALUE_RE =
  /#([0-9a-f]{3,8})\b|\b\d+(\.\d+)?\s?(px|rem|em|%|pt|vh|vw)\b|\b(red|blue|green|black|white|gray|grey|yellow|orange|purple|pink|teal|navy|dark|light|bold|italic|transparent)\b/i;

export async function readSelectionContents(selection: Selection, root: string): Promise<Map<string, string>> {
  // primary + supporting are the full-content files — the ambiguous element
  // Scan all three tiers: even a file we'd only send as signatures can hold a
  // second copy of the target, and missing it is exactly the destructive bug
  // we're guarding against.
  const files = [...selection.primary, ...selection.supporting, ...selection.optional];
  const contents = new Map<string, string>();
  for (const f of files) {
    if (contents.has(f.path)) continue;
    contents.set(f.path, await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => ""));
  }
  return contents;
}

export function detectAmbiguity(task: string, frame: IntentFrame, contents: Map<string, string>): AmbiguityReport {
  return {
    duplicate: detectDuplicate(task, contents),
    styleUnderspecified: frame.action === "restyle" && !STYLE_VALUE_RE.test(frame.raw),
  };
}

/**
 * Where does the task's *specific* target live, and does it resolve to more
 * than one place? Two ways in: a quoted phrase in the task, or repeated element
 * copy the task references by its words. 2–9 distinct locations (one =
 * unambiguous, many = a global rename rather than a targeting question).
 */
export function detectDuplicate(task: string, contents: Map<string, string>): DuplicateFinding | null {
  const quoted = [...task.matchAll(QUOTE_RE)].map((m) => m[1].trim()).filter(Boolean);
  for (const phrase of quoted) {
    const instances = findPhraseLocations(phrase, contents);
    if (instances.length >= 2 && instances.length <= 9) return finalizeFinding(phrase, instances);
  }

  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const groups = new Map<string, Instance[]>();
  const display = new Map<string, string>();
  for (const [file, content] of contents) {
    if (!UI_FILE.test(file)) continue;
    const lines = content.split("\n");
    for (const node of textNodes(content)) {
      const key = node.text.toLowerCase();
      display.set(key, node.text);
      const loc = makeInstance(file, node.line, node.text, enclosingLandmark(lines, node.line - 1));
      const bucket = groups.get(key) ?? [];
      if (!bucket.some((b) => b.value === loc.value)) bucket.push(loc);
      groups.set(key, bucket);
    }
  }
  for (const [key, instances] of groups) {
    if (instances.length < 2 || instances.length > 9) continue;
    const sig = key.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (sig.length === 0) continue;
    const overlap = sig.filter((w) => taskWords.has(w)).length;
    // The task must actually reference this copy: at least two significant
    // words (or all, if fewer) and a majority present in the task.
    if (overlap < Math.min(2, sig.length) || overlap / sig.length < 0.5) continue;
    return finalizeFinding(display.get(key) ?? key, instances);
  }
  return null;
}

function finalizeFinding(phrase: string, instances: Instance[]): DuplicateFinding {
  const files = new Set(instances.map((i) => i.file));
  const sections = new Set(instances.map((i) => i.landmark || `${i.file}:${i.line}`));
  return { phrase, instances, crossFile: files.size > 1, crossSection: sections.size > 1 };
}

/** Visible text nodes in a file, tag-agnostic and multi-line, with 1-based line. */
function textNodes(content: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const m of content.matchAll(TEXT_NODE_RE)) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 60) continue;
    if (!/[A-Za-z]/.test(text)) continue; // needs a letter — skip whitespace/punctuation runs
    if (CODEY_RE.test(text)) continue; // looks like code, not visible copy
    // Point at the first non-space char of the captured text (may be on a later
    // line than the opening '>' for multi-line elements).
    const lead = m[1].length - m[1].trimStart().length;
    const idx = (m.index ?? 0) + 1 + lead;
    out.push({ line: content.slice(0, idx).split("\n").length, text });
  }
  return out;
}

function findPhraseLocations(phrase: string, contents: Map<string, string>): Instance[] {
  const needle = phrase.toLowerCase();
  const out: Instance[] = [];
  const seen = new Set<string>();
  for (const [file, content] of contents) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(needle)) return;
      const value = `${file}:${i + 1}`;
      if (seen.has(value)) return;
      seen.add(value);
      out.push(makeInstance(file, i + 1, line, UI_FILE.test(file) ? enclosingLandmark(lines, i) : ""));
    });
  }
  return out;
}

function makeInstance(file: string, line: number, snippet: string, landmark: string): Instance {
  const where = landmark ? ` · in <${landmark}>` : "";
  return {
    file,
    line,
    landmark,
    text: cleanSnippet(snippet),
    value: `${file}:${line}${where}`,
    label: `${file}:${line}${where} → ${cleanSnippet(snippet)}`,
  };
}

/** Nearest enclosing landmark scanning upward — labels otherwise-identical copy. */
export function enclosingLandmark(lines: string[], idx: number): string {
  for (let i = idx; i >= 0 && i >= idx - 80; i--) {
    const m = lines[i].match(LANDMARK_RE);
    if (!m) continue;
    const id = m[2].match(/\bid=["']([^"']+)["']/);
    return id ? `${m[1].toLowerCase()}#${id[1]}` : m[1].toLowerCase();
  }
  return "";
}

function cleanSnippet(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 58 ? `${collapsed.slice(0, 55)}…` : collapsed;
}

// ────────────────────── Resolution confidence + bands ───────────────────────

/**
 * How clearly the top target beats the alternatives — the spec's ambiguity
 * margin, made relative to the top score rather than a fixed threshold.
 * 0 = a toss-up, 1 = a runaway winner.
 */
export function resolutionConfidence(selection: Selection): number {
  const [top, second] = selection.anchors;
  if (!top) return 0.2;
  if (!second) return Math.min(1, 0.6 + top.score * 0.4);
  const margin = top.score > 0 ? (top.score - second.score) / top.score : 0;
  return Math.max(0, Math.min(1, 0.35 + margin));
}

/**
 * The ranking is confident about the *target* when one anchor clearly
 * dominates and the primary (edit-target) tier is focused. Kept here so the
 * confidence notion lives with the understanding layer; re-exported by clarify.
 */
export function rankingIsConfident(selection: Selection): boolean {
  const [top, second] = selection.anchors;
  if (!top) return false;
  const dominant = top.score >= 0.4 && (!second || top.score - second.score >= 0.12 || top.score >= 0.7);
  return dominant && selection.primary.length <= 2;
}

export type Band = "green" | "yellow" | "orange" | "red";

export interface BandDecision {
  band: Band;
  reason: string;
}

/**
 * Four-band classifier (spec §Decision bands). Infer first, ask later:
 *  • Red    — a destructive edit collides with identical targets in different
 *             places (delete/hide/move the wrong shared thing). Block.
 *  • Orange — a target genuinely resolves to several candidates; one narrow
 *             question fixes it. Ask.
 *  • Yellow — target is clear but the styling is underspecified; borrow from the
 *             existing design instead of interrupting. Execute conservatively.
 *  • Green  — one clear target, low risk. Execute.
 */
export function classifyBand(frame: IntentFrame, selection: Selection, ambiguity: AmbiguityReport): BandDecision {
  const destructive = frame.risk === "destructive";

  if (ambiguity.duplicate) {
    const { instances, crossFile, crossSection, phrase } = ambiguity.duplicate;
    const broadImpact = crossFile || crossSection || instances.length >= 3;
    if (destructive && broadImpact) {
      return {
        band: "red",
        reason: `“${phrase}” appears in ${instances.length} places (${sectionSummary(instances)}); a ${frame.action} would hit all of them`,
      };
    }
    return { band: "orange", reason: `“${phrase}” matches ${instances.length} targets (${sectionSummary(instances)})` };
  }

  if (ambiguity.styleUnderspecified && rankingIsConfident(selection)) {
    return { band: "yellow", reason: "target is clear but styling is underspecified — will continue the existing design" };
  }

  if (rankingIsConfident(selection)) return { band: "green", reason: "one clearly dominant target" };

  // No concrete collision, but the ranking couldn't single out an edit target
  // among several files — a focused "which file" question can resolve it.
  if (selection.primary.length >= 3) {
    return { band: "orange", reason: "several files could be the edit target" };
  }
  return { band: "green", reason: "target resolved by ranking" };
}

/** "the navbar and the footer" / "3 sections" — human summary of where copies live. */
export function sectionSummary(instances: Instance[]): string {
  const labels = [...new Set(instances.map((i) => friendlyLandmark(i.landmark)).filter(Boolean))];
  if (labels.length === 0) return `${instances.length} places`;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function friendlyLandmark(landmark: string): string {
  if (!landmark) return "";
  if (landmark.includes("#")) {
    const [tag, id] = landmark.split("#");
    return tag === "section" ? `the ${id} section` : `the ${id} ${tag}`;
  }
  const NICE: Record<string, string> = {
    nav: "the navbar",
    header: "the header",
    footer: "the footer",
    main: "the main content",
    aside: "the sidebar",
    section: "a section",
    form: "the form",
    dialog: "the dialog",
    table: "the table",
  };
  return NICE[landmark] ?? `the ${landmark}`;
}
