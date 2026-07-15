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
import { buildElementGraph } from "./semantic/graph";
import type { ElementGraph, UIElement } from "./semantic/types";

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
  sharedComponent?: boolean; // all instances are the same React component → a definition edit hits all
  inLoop?: boolean; // at least one instance is list-rendered → one source, many runtime instances
}

export interface ListTarget {
  role: string;
  instance: Instance;
}

export interface AmbiguityReport {
  duplicate: DuplicateFinding | null;
  styleUnderspecified: boolean; // restyle request with no concrete color/size/etc.
  listTarget?: ListTarget | null; // destructive edit aimed at a list-rendered element
  /** The copy the task named matches exactly one element — nothing to ask. */
  resolvedTarget?: Instance | null;
  /** The task named a page/file, so the edit target's file is already known. */
  scoped?: boolean;
}

export interface TargetAnalysis {
  duplicate: DuplicateFinding | null;
  resolvedTarget: Instance | null;
}

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

/**
 * Post-edit scope enforcement: given the occurrences the user said to KEEP,
 * report any that no longer exist. Re-parses the files after the agent ran and
 * matches by landmark + text (not line), so it survives the agent shifting
 * lines or reformatting — but catches it deleting/altering a copy it was told
 * to leave alone. This is what turns "the agent obeyed" into "Glint verified".
 */
export async function findMissingKeeps(root: string, keep: Instance[]): Promise<Instance[]> {
  if (keep.length === 0) return [];
  const contents = new Map<string, string>();
  for (const file of new Set(keep.map((k) => k.file))) {
    contents.set(file, await fs.readFile(nodePath.join(root, file), "utf8").catch(() => ""));
  }
  const graph = buildElementGraph(contents);
  return keep.filter((k) => {
    // Instance text may be display-truncated ("…"); compare as a prefix.
    const norm = k.text.replace(/…$/, "").trim().toLowerCase();
    if (!norm) return false;
    if (k.landmark) {
      return !graph.elements.some(
        (e) => e.file === k.file && e.landmark === k.landmark && e.text.trim().toLowerCase().startsWith(norm),
      );
    }
    return !(contents.get(k.file) ?? "").toLowerCase().includes(norm);
  });
}

export function detectAmbiguity(task: string, frame: IntentFrame, contents: Map<string, string>): AmbiguityReport {
  const graph = buildElementGraph(contents); // parse once, share across detectors
  const scope = scopeFiles(task, [...contents.keys()]);
  const { duplicate, resolvedTarget } = analyzeTargets(graph, task, contents, scope);
  return {
    duplicate,
    resolvedTarget,
    scoped: scope !== null,
    styleUnderspecified: frame.action === "restyle" && !STYLE_VALUE_RE.test(frame.raw),
    listTarget: frame.risk === "destructive" ? detectListTarget(graph, task, scope) : null,
  };
}

/**
 * Files the task explicitly scopes to by page/file name — e.g. "…from the index
 * page" or "…in checkout.tsx". When present, detection is restricted to these
 * files so occurrences on other pages aren't offered as targets. Returns null
 * when the task names no file (don't over-filter).
 */
function scopeFiles(task: string, files: string[]): Set<string> | null {
  const words = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const matched = new Set<string>();
  for (const f of files) {
    const base = nodePath.basename(f).toLowerCase(); // e.g. index.html
    const stem = base.replace(/\.[^.]+$/, ""); // e.g. index
    const aliases = new Set([base, stem]);
    // "home"/"homepage"/"landing" all point at the index / page entry file.
    if (stem === "index" || stem === "page") for (const a of ["home", "homepage", "landing", "index"]) aliases.add(a);
    if ([...aliases].some((a) => a.length >= 3 && words.has(a))) matched.add(f);
  }
  return matched.size > 0 ? matched : null;
}

function inScope(file: string, scope: Set<string> | null): boolean {
  return !scope || scope.has(file);
}

/** A destructive action aimed at a list-rendered element affects every item. */
function detectListTarget(graph: ElementGraph, task: string, scope: Set<string> | null): ListTarget | null {
  const words = [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
  if (words.length === 0) return null;
  for (const el of graph.elements) {
    if (!el.inLoop || !inScope(el.file, scope)) continue;
    const hay = `${el.role} ${el.text} ${Object.values(el.attributes).join(" ")}`.toLowerCase();
    if (words.some((w) => hay.includes(w))) return { role: el.role, instance: elementInstance(el) };
  }
  return null;
}

/**
 * Where does the task's *specific* target live, and does it resolve to more
 * than one place? Runs over the semantic element graph (real AST/DOM), so it
 * sees multi-line elements, React components, and list rendering — not just
 * single-line text. Two ways in: a quoted phrase in the task, or repeated
 * element copy the task references by its words. 2–9 distinct locations (one =
 * unambiguous, many = a global rename rather than a targeting question).
 */
export function detectDuplicate(task: string, contents: Map<string, string>): DuplicateFinding | null {
  return analyzeTargets(buildElementGraph(contents), task, contents, scopeFiles(task, [...contents.keys()])).duplicate;
}

/**
 * Resolve what the task names to concrete elements. Three outcomes:
 *   • several matches  → a duplicate collision (ask which)
 *   • exactly one      → the target is known (nothing to ask — proceed)
 *   • none             → the task named no locatable copy (fall back to heuristics)
 * Knowing "exactly one" matters as much as knowing "several": it's what stops
 * Glint asking "which button?" when the task already said which.
 */
function analyzeTargets(
  graph: ElementGraph,
  task: string,
  contents: Map<string, string>,
  scope: Set<string> | null,
): TargetAnalysis {
  // Honor a page/file the task named: only consider elements on that page, so
  // the same copy on other pages isn't offered as a target.
  const elements = graph.elements.filter((e) => inScope(e.file, scope));
  const scopedContents = scope ? new Map([...contents].filter(([f]) => scope.has(f))) : contents;
  const quoted = [...task.matchAll(QUOTE_RE)].map((m) => m[1].trim()).filter(Boolean);

  // 1. Quoted target — the strongest signal. Match structurally against element
  //    text and attributes; fall back to a raw line scan so plain text and
  //    attributes like aria-label/title/alt still resolve.
  for (const phrase of quoted) {
    const els = dedupeElements(elementsMatchingPhrase(elements, phrase));
    if (els.length >= 2 && els.length <= 9) {
      return { duplicate: finalizeFinding(phrase, els.map(elementInstance), els), resolvedTarget: null };
    }
    if (els.length === 1) return { duplicate: null, resolvedTarget: elementInstance(els[0]) };
    const raw = findPhraseLocations(phrase, scopedContents);
    if (raw.length >= 2 && raw.length <= 9) return { duplicate: finalizeFinding(phrase, raw), resolvedTarget: null };
  }

  // 2. Element copy the task references by its words.
  const referenced = referencedGroups(elements, task);
  const collided = referenced.find((r) => r.length >= 2);
  if (collided) {
    return { duplicate: finalizeFinding(collided[0].text, collided.map(elementInstance), collided), resolvedTarget: null };
  }
  // Exactly one referenced copy, matching exactly one element → target known.
  // (Two different referenced copies means the task named two things — still
  // ambiguous, so leave it to the fallback heuristics.)
  if (referenced.length === 1 && referenced[0].length === 1) {
    return { duplicate: null, resolvedTarget: elementInstance(referenced[0][0]) };
  }
  return { duplicate: null, resolvedTarget: null };
}

/** Element groups (by identical copy) that the task actually refers to. */
function referencedGroups(elements: UIElement[], task: string): UIElement[][] {
  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const groups = new Map<string, UIElement[]>();
  for (const el of elements) {
    if (!el.text) continue; // dynamic/empty text can't be named by copy
    const key = el.text.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), el]);
  }
  const out: UIElement[][] = [];
  for (const [key, group] of groups) {
    const els = dedupeElements(group);
    if (els.length > 9) continue; // a global rename, not a targeting question
    const sig = key.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (sig.length === 0) continue;
    const overlap = sig.filter((w) => taskWords.has(w)).length;
    // The task must actually reference this copy: at least two significant
    // words (or all, if fewer) and a majority present in the task.
    if (overlap < Math.min(2, sig.length) || overlap / sig.length < 0.5) continue;
    out.push(els);
  }
  return out;
}

function elementsMatchingPhrase(elements: UIElement[], phrase: string): UIElement[] {
  const needle = phrase.toLowerCase();
  return elements.filter(
    (el) =>
      el.text.toLowerCase().includes(needle) ||
      Object.values(el.attributes).some((v) => v.toLowerCase().includes(needle)),
  );
}

function dedupeElements(els: UIElement[]): UIElement[] {
  const seen = new Set<string>();
  return els.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}

const elementInstance = (el: UIElement): Instance => makeInstance(el.file, el.line, el.text, el.landmark);

function finalizeFinding(phrase: string, instances: Instance[], els?: UIElement[]): DuplicateFinding {
  const files = new Set(instances.map((i) => i.file));
  const sections = new Set(instances.map((i) => i.landmark || `${i.file}:${i.line}`));
  return {
    phrase,
    instances,
    crossFile: files.size > 1,
    crossSection: sections.size > 1,
    // Blast-radius facts from the graph: the same component reused everywhere,
    // or a list-rendered element (one source → many runtime instances).
    sharedComponent: !!els && els.length >= 2 && els.every((e) => e.kind === "component") && new Set(els.map((e) => e.role)).size === 1,
    inLoop: !!els && els.some((e) => e.inLoop),
  };
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
    const { instances, crossFile, crossSection, sharedComponent, inLoop, phrase } = ambiguity.duplicate;
    const broadImpact = crossFile || crossSection || instances.length >= 3 || !!sharedComponent || !!inLoop;
    if (destructive && broadImpact) {
      const why = inLoop
        ? `“${phrase}” is list-rendered — a ${frame.action} would affect every item`
        : sharedComponent
          ? `“${phrase}” is the same component reused in ${instances.length} places (${sectionSummary(instances)}); a ${frame.action} to it would hit all of them`
          : `“${phrase}” appears in ${instances.length} places (${sectionSummary(instances)}); a ${frame.action} would hit all of them`;
      return { band: "red", reason: why };
    }
    return { band: "orange", reason: `“${phrase}” matches ${instances.length} targets (${sectionSummary(instances)})` };
  }

  if (destructive && ambiguity.listTarget) {
    const t = ambiguity.listTarget;
    return {
      band: "red",
      reason: `“${t.instance.text || t.role}” is rendered from a list — a ${frame.action} would remove every item, not one`,
    };
  }

  if (ambiguity.styleUnderspecified && (rankingIsConfident(selection) || ambiguity.resolvedTarget)) {
    return { band: "yellow", reason: "target is clear but styling is underspecified — will continue the existing design" };
  }

  // The task named a copy that resolves to exactly one element — there is
  // nothing to ask, regardless of how many files the ranking surfaced.
  if (ambiguity.resolvedTarget) {
    const t = ambiguity.resolvedTarget;
    const where = t.landmark ? ` inside <${t.landmark}>` : "";
    return { band: "green", reason: `“${t.text}”${where} (${t.file}) is the only match` };
  }

  if (rankingIsConfident(selection)) return { band: "green", reason: "one clearly dominant target" };

  // No concrete collision, but the ranking couldn't single out an edit target
  // among several files — a focused "which file" question can resolve it. Skip
  // when the task already named the page/file.
  if (!ambiguity.scoped && selection.primary.length >= 3) {
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
