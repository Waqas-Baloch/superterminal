import { promises as fs } from "node:fs";
import nodePath from "node:path";
import prompts from "prompts";
import pc from "picocolors";
import { STOPWORDS, type Selection } from "./selector";
import { log } from "../util/logger";

export interface ClarifyQuestion {
  key: string;
  message: string;
  choices: { title: string; value: string }[];
  refine: (answer: string[]) => string | null;
}

interface Candidate {
  title: string; // "index.html:3 → <button class=\"buy\">Buy now"
  snippet: string; // just the element part, for specificity matching
}

// Task words that name UI elements → the HTML tags they may refer to.
const TAG_ALIASES: Record<string, string[]> = {
  button: ["button"],
  link: ["a"],
  image: ["img"],
  img: ["img"],
  form: ["form"],
  input: ["input", "select", "textarea"],
  heading: ["h1", "h2", "h3"],
  title: ["h1", "title"],
  nav: ["nav"],
  navbar: ["nav"],
  header: ["header"],
  footer: ["footer"],
  section: ["section"],
  table: ["table"],
  modal: ["dialog"],
  list: ["ul", "ol"],
};

const UI_FILE = /\.(html?|jsx|tsx)$/;
const STYLE_FILE = /\.(css|scss)$/;
const MAX_ELEMENT_QUESTIONS = 2;

/**
 * The ranking system exists to decide, not defer. Only clarify when it's
 * genuinely uncertain about the target: no dominant anchor, or the top few
 * anchors are near-tied (the ranking couldn't single out an edit target).
 * A clearly dominant anchor + a focused primary tier means "trust it."
 */
export function rankingIsConfident(selection: Selection): boolean {
  const [top, second] = selection.anchors;
  if (!top) return false;
  const dominant = top.score >= 0.4 && (!second || top.score - second.score >= 0.12 || top.score >= 0.7);
  return dominant && selection.primary.length <= 2;
}

/**
 * Detect what the task leaves ambiguous, given what was actually selected.
 * Pure + offline: candidates come from scanning the selected files, so every
 * option shown to the user is a real element in their code.
 */
export async function buildQuestions(task: string, selection: Selection, root: string): Promise<ClarifyQuestion[]> {
  const questions: ClarifyQuestion[] = [];
  // primary + supporting are both sent as full content — either could hold
  // the ambiguous element, so both are fair game for clarification questions.
  const fullFiles = [...selection.primary, ...selection.supporting];
  const contents = new Map<string, string>();
  for (const f of fullFiles) {
    contents.set(f.path, await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => ""));
  }

  // 1. Duplicate visible target: the same copy — the exact thing the user
  // named, e.g. `remove "This Testing"` — appears in several places (a button
  // in the nav AND one in the footer). This is keyed on the *content* the task
  // references, not a tag word, so it fires even when the task never says
  // "button". It runs regardless of file-confidence: the file can be certain
  // while *which occurrence* is not. When it fires it is the most precise
  // question we can ask, so it supersedes the tag-word heuristic below.
  const dup = collectDuplicateTargets(task, contents);
  if (dup) {
    questions.push({
      key: "target_location",
      message: `"${dup.phrase}" appears in ${dup.locations.length} places — which should I change?`,
      choices: [
        ...dup.locations.map((l) => ({ title: l.label, value: l.value })),
        { title: "All of them", value: "__all__" },
      ],
      refine: (answer) => {
        if (!answer || answer.length === 0) return null;
        if (answer.includes("__all__")) {
          return `Apply the change to all ${dup.locations.length} occurrences of "${dup.phrase}".`;
        }
        const picked = answer.filter((a) => a !== "__all__");
        if (picked.length === 0) return null;
        return `Apply the change ONLY at ${picked.join(" and ")} (the "${dup.phrase}" there). Leave every other occurrence of "${dup.phrase}" unchanged.`;
      },
    });
  } else {
    // 1b. Element ambiguity: "the button" when there are several buttons.
    // Case-dependent: if the task's own words already single out one candidate
    // ("the BUY button"), the prompt is specific enough — no question.
    const words = [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
    const discriminators = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !TAG_ALIASES[w]);
    for (const word of words) {
      if (!TAG_ALIASES[word]) continue;
      const candidates = collectCandidates(word, contents);
      if (candidates.length < 2 || candidates.length > 9) continue;

      const matched = candidates.filter((c) =>
        discriminators.some((d) => c.snippet.toLowerCase().includes(d)),
      );
      if (matched.length === 1) continue; // task already pins it down — proceed silently
      const pool = matched.length >= 2 ? matched : candidates; // narrowed but still ambiguous → ask among the matches

      questions.push({
        key: `target_${word}`,
        message: `Your task mentions "${word}" — I found ${pool.length}. Which do you mean?`,
        choices: [
          ...pool.map((c) => ({ title: c.title, value: c.title })),
          { title: "All of them", value: "__all__" },
        ],
        refine: (answer) => {
          if (!answer || answer.length === 0) return null;
          if (answer.includes("__all__")) return `Apply the change to every ${word} in the selected files.`;
          return `The "${word}" means exactly: ${answer.join(" AND ")}. Do not modify any other ${word}.`;
        },
      });
      if (questions.length >= MAX_ELEMENT_QUESTIONS) break;
    }
  }

  // 2. File scope: several primary (edit-target) files, task names none of
  // them, and the ranking couldn't pick a clear winner. Supporting files are
  // context, not edit targets, so they don't drive this question. Gated on
  // confidence — this is the "which file" question that tends to over-ask;
  // when the ranking has a dominant anchor we trust it and stay silent.
  if (!rankingIsConfident(selection) && selection.primary.length >= 3) {
    const taskLower = task.toLowerCase();
    const namesAFile = selection.primary.some((f) => taskLower.includes(nodePath.basename(f.path).toLowerCase()));
    if (!namesAFile) {
      questions.push({
        key: "file_scope",
        message: "Which file(s) should actually be changed?",
        choices: [
          ...selection.primary.map((f) => ({ title: f.path, value: f.path })),
          { title: "Wherever needed — let the agent decide", value: "__any__" },
        ],
        refine: (answer) => {
          if (!answer || answer.length === 0 || answer.includes("__any__")) return null;
          return `Only make changes in: ${answer.join(", ")}. Treat other files as read-only context.`;
        },
      });
    }
  }

  return questions;
}

/**
 * Interactive loop: ask the generated questions plus open follow-ups, and
 * return refinement sentences to compile into the task. Ctrl-C or empty
 * answers stop gracefully.
 */
export async function askClarifications(task: string, selection: Selection, root: string): Promise<string[]> {
  const refinements: string[] = [];

  // We no longer short-circuit on file-confidence here. buildQuestions itself
  // decides what's worth asking: it stays silent when the target is clear, but
  // still surfaces a genuinely ambiguous target — e.g. the same copy appearing
  // in several places — even when the *file* is a confident single anchor.
  // (The noisy "which file" question remains gated on confidence internally.)
  const questions = await buildQuestions(task, selection, root);
  if (questions.length === 0) return refinements; // nothing ambiguous to ask

  log.info("");
  log.dim("Quick check to target the change precisely (space = select, enter = confirm):");

  for (const q of questions) {
    const answer = await prompts({
      type: "multiselect",
      name: q.key,
      message: q.message,
      choices: q.choices,
      instructions: false,
    });
    if (answer[q.key] === undefined) return refinements; // cancelled — use what we have
    const line = q.refine(answer[q.key] as string[]);
    if (line) {
      refinements.push(line);
      log.dim(`  ✓ noted`);
    }
  }
  // No open-ended "anything else?" rounds — the confirm step's "Edit manifest"
  // covers adding context, so decisions stay quick.

  return refinements;
}

export function compileTask(task: string, refinements: string[]): string {
  if (refinements.length === 0) return task;
  return `${task}\n\nClarified details:\n${refinements.map((r) => `- ${r}`).join("\n")}`;
}

interface DupLocation {
  file: string;
  line: number;
  label: string; // shown to the user, e.g. `index.html:8 · in <footer> → This Testing`
  value: string; // compiled into the refinement, e.g. `index.html:8 · in <footer>`
}
interface DupTarget {
  phrase: string;
  locations: DupLocation[];
}

// Inline elements whose visible text a user is likely to name ("remove the
// Buy now button" / "remove This Testing"). Single-line open→text→close only;
// {…} is excluded so JSX expressions aren't captured as literal text.
const ELEMENT_RE =
  /<(button|a|h1|h2|h3|h4|h5|li|label|span|p|strong|em|small|figcaption|option|summary|td|th)\b[^>]*>([^<>{}]{2,60})<\/\s*\1\s*>/gi;

// Landmarks used to tell otherwise-identical occurrences apart (nav vs footer).
const LANDMARK_RE = /<(nav|header|footer|main|aside|section|form|dialog|table)\b([^>]*)>/i;

/**
 * Find where the task's *specific* target lives, and if it resolves to more
 * than one place, return them so the user can pick. Two ways in:
 *   1. A quoted phrase in the task (`remove "This Testing"`) — matched as a
 *      substring across UI files, so it catches visible text and attributes.
 *   2. Repeated element copy the task references by its words (two buttons both
 *      reading "This Testing", task says "remove This Testing").
 * Distinct file:line locations only; 2–9 of them (one = unambiguous, many = a
 * global rename, not a targeting question).
 */
function collectDuplicateTargets(task: string, contents: Map<string, string>): DupTarget | null {
  // 1. Quoted target — the strongest signal that the user named one thing.
  const quoted = [...task.matchAll(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/g)].map((m) => m[1].trim()).filter(Boolean);
  for (const phrase of quoted) {
    const locations = findPhraseLocations(phrase, contents);
    if (locations.length >= 2 && locations.length <= 9) return { phrase, locations };
  }

  // 2. Repeated element copy the task refers to.
  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const groups = new Map<string, DupLocation[]>();
  const display = new Map<string, string>();
  for (const [file, content] of contents) {
    if (!UI_FILE.test(file)) continue;
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(ELEMENT_RE)) {
        const text = m[2].replace(/\s+/g, " ").trim();
        if (!text) continue;
        const key = text.toLowerCase();
        display.set(key, text);
        const loc = makeLocation(file, i + 1, text, enclosingLandmark(lines, i));
        const bucket = groups.get(key) ?? [];
        if (!bucket.some((b) => b.value === loc.value)) bucket.push(loc);
        groups.set(key, bucket);
      }
    });
  }
  for (const [key, locations] of groups) {
    if (locations.length < 2 || locations.length > 9) continue;
    const sig = key.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (sig.length === 0) continue;
    const overlap = sig.filter((w) => taskWords.has(w)).length;
    // The task must actually reference this copy: at least two significant
    // words (or all, if fewer) and a majority of them present in the task.
    if (overlap < Math.min(2, sig.length) || overlap / sig.length < 0.5) continue;
    return { phrase: display.get(key) ?? key, locations };
  }
  return null;
}

function findPhraseLocations(phrase: string, contents: Map<string, string>): DupLocation[] {
  const needle = phrase.toLowerCase();
  const out: DupLocation[] = [];
  const seen = new Set<string>();
  for (const [file, content] of contents) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(needle)) return;
      const value = `${file}:${i + 1}`;
      if (seen.has(value)) return;
      seen.add(value);
      out.push(makeLocation(file, i + 1, line, UI_FILE.test(file) ? enclosingLandmark(lines, i) : ""));
    });
  }
  return out;
}

function makeLocation(file: string, line: number, snippet: string, landmark: string): DupLocation {
  const where = landmark ? ` · in <${landmark}>` : "";
  return { file, line, label: `${file}:${line}${where} → ${clean(snippet)}`, value: `${file}:${line}${where}` };
}

/** Nearest enclosing landmark tag scanning upward — labels identical copy. */
function enclosingLandmark(lines: string[], idx: number): string {
  for (let i = idx; i >= 0 && i >= idx - 80; i--) {
    const m = lines[i].match(LANDMARK_RE);
    if (!m) continue;
    const id = m[2].match(/\bid=["']([^"']+)["']/);
    return id ? `${m[1].toLowerCase()}#${id[1]}` : m[1].toLowerCase();
  }
  return "";
}

function collectCandidates(term: string, contents: Map<string, string>): Candidate[] {
  const out: Candidate[] = [];
  const tags = TAG_ALIASES[term] ?? [];

  for (const [file, content] of contents) {
    const lines = content.split("\n");
    if (UI_FILE.test(file)) {
      lines.forEach((line, i) => {
        for (const tag of tags) {
          const re = new RegExp(`<${tag}\\b[^>]*>(?:[^<]{0,40})?`, "gi");
          for (const m of line.matchAll(re)) {
            const snippet = clean(m[0]);
            out.push({ title: `${file}:${i + 1} → ${snippet}`, snippet });
          }
        }
      });
    } else if (STYLE_FILE.test(file)) {
      lines.forEach((line, i) => {
        if (!line.includes("{")) return;
        const selector = line.split("{")[0];
        const lower = selector.toLowerCase();
        if (lower.includes(term) || tags.some((t) => lower.includes(t))) {
          const snippet = `${clean(selector)} rule`;
          out.push({ title: `${file}:${i + 1} → ${snippet}`, snippet });
        }
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.title) ? false : (seen.add(c.title), true))).slice(0, 8);
}

function clean(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 58 ? `${collapsed.slice(0, 55)}…` : collapsed;
}
