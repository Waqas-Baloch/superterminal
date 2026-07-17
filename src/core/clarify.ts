import nodePath from "node:path";
import prompts from "prompts";
import { STOPWORDS, type Selection } from "./selector";
import { log } from "../util/logger";
import {
  buildIntentFrame,
  classifyBand,
  detectAmbiguity,
  impactSeverity,
  rankingIsConfident,
  readSelectionContents,
  sectionSummary,
  STYLE_FILE,
  UI_FILE,
  type AmbiguityReport,
  type Band,
  type DuplicateFinding,
  type Impact,
  type Instance,
  type IntentFrame,
} from "./understanding";

// Re-exported so existing importers (and tests) keep their entry point.
export { rankingIsConfident };

export interface ClarifyQuestion {
  key: string;
  message: string;
  choices: { title: string; value: string }[];
  refine: (answer: string[]) => string | null;
  /** Machine-readable edit scope, so Glint can verify the agent honored it. */
  scopeFor?: (answer: string[]) => EditScope | null;
  /** Single-choice (a confirmation), not a multi-select target list. */
  single?: boolean;
}

/**
 * What the user actually authorized: the occurrences to change, and the ones
 * that must survive untouched. Prose tells the agent; this lets Glint check.
 */
export interface EditScope {
  phrase: string;
  change: Instance[];
  keep: Instance[];
}

export interface ClarifyResult {
  refinements: string[];
  scope: EditScope | null;
  cancelled: boolean; // the user chose to abort (e.g. declined a risky impact)
}

export interface TaskAssessment {
  band: Band;
  reason: string;
  frame: IntentFrame;
  questions: ClarifyQuestion[]; // focused clarifications — empty for Green/Yellow
  styleNote: string | null; // Yellow: style-continuation guidance to compile in
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

const MAX_ELEMENT_QUESTIONS = 2;

/**
 * Full assessment of a task against what was selected: the intent frame, the
 * decision band, the focused questions to ask (if any), and — for Yellow — a
 * style-continuation note. This is the entry point the run flow uses to decide
 * whether to auto-execute, infer style, ask, or block.
 */
export async function assessTask(task: string, selection: Selection, root: string): Promise<TaskAssessment> {
  const contents = await readSelectionContents(selection, root);
  const frame = buildIntentFrame(task);
  const ambiguity = detectAmbiguity(task, frame, contents);
  const { band, reason } = classifyBand(frame, selection, ambiguity);
  const questions = composeQuestions(frame, ambiguity, selection, task, contents);
  const styleNote = band === "yellow" ? styleContinuationNote() : null;
  return { band, reason, frame, questions, styleNote };
}

/**
 * The clarifying questions for a task, given what was selected. Kept as a
 * stable entry point (used directly by tests): it reflects exactly what
 * assessTask would ask.
 */
export async function buildQuestions(task: string, selection: Selection, root: string): Promise<ClarifyQuestion[]> {
  const contents = await readSelectionContents(selection, root);
  const frame = buildIntentFrame(task);
  const ambiguity = detectAmbiguity(task, frame, contents);
  return composeQuestions(frame, ambiguity, selection, task, contents);
}

function composeQuestions(
  frame: IntentFrame,
  ambiguity: AmbiguityReport,
  selection: Selection,
  task: string,
  contents: Map<string, string>,
): ClarifyQuestion[] {
  const questions: ClarifyQuestion[] = [];

  // 0. Impact confirmation: the target is unambiguous, but a destructive edit
  // to it would break other code. Not a "which one?" — a "this breaks N things,
  // proceed?". Fires ahead of everything else.
  if (frame.risk === "destructive" && ambiguity.impact && impactSeverity(ambiguity.impact) !== "low") {
    questions.push(impactQuestion(frame, ambiguity.impact));
    return questions; // the target is already known; nothing else to ask
  }

  // 1. Duplicate visible target: the exact copy the user named appears in
  // several places (a button in the nav AND one in the footer). This is the
  // most precise question we can ask, so it supersedes the tag-word heuristic.
  // It fires regardless of file-confidence — the file can be certain while
  // *which occurrence* is not.
  if (ambiguity.duplicate) {
    questions.push(duplicateQuestion(frame, ambiguity.duplicate));
  } else if (!ambiguity.resolvedTarget) {
    // The task named a copy that matches exactly one element — the target is
    // already known, so asking "which button?" would be pure noise. (This is
    // also what stops us listing unrelated <button>s when the named target is
    // an <a>/component that simply isn't a button.)
    //
    // 1b. Element ambiguity: "the button" when there are several buttons. If
    // the task's own words single out one ("the BUY button"), stay silent.
    const words = [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
    const discriminators = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !TAG_ALIASES[w]);
    for (const word of words) {
      if (!TAG_ALIASES[word]) continue;
      const candidates = collectCandidates(word, contents);
      if (candidates.length < 2 || candidates.length > 9) continue;

      const matched = candidates.filter((c) => discriminators.some((d) => c.snippet.toLowerCase().includes(d)));
      if (matched.length === 1) continue; // task already pins it down — proceed silently
      const pool = matched.length >= 2 ? matched : candidates; // narrowed but still ambiguous → ask among the matches

      questions.push({
        key: `target_${word}`,
        message: `Your task mentions "${word}" — I found ${pool.length}. Which do you mean?`,
        choices: [...pool.map((c) => ({ title: c.title, value: c.title })), { title: "All of them", value: "__all__" }],
        refine: (answer) => {
          if (!answer || answer.length === 0) return null;
          if (answer.includes("__all__")) return `Apply the change to every ${word} in the selected files.`;
          return `The "${word}" means exactly: ${answer.join(" AND ")}. Do not modify any other ${word}.`;
        },
      });
      if (questions.length >= MAX_ELEMENT_QUESTIONS) break;
    }
  }

  // 2. File scope: several primary (edit-target) files, task names none, and
  // the ranking couldn't pick a clear winner. Gated on confidence — this is the
  // "which file" question that tends to over-ask. Also skipped when the target
  // already resolved to one element, or the task named the page ("home page"),
  // in which case we already know the file.
  if (
    !ambiguity.resolvedTarget &&
    !ambiguity.scoped &&
    !rankingIsConfident(selection) &&
    selection.primary.length >= 3
  ) {
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

// Evidence-backed clarification (spec §Clarification policy): name the copy and
// where each instance lives, rather than a bare "which one?".
function duplicateQuestion(frame: IntentFrame, dup: DuplicateFinding): ClarifyQuestion {
  const verb = frame.action === "other" || frame.action === "add" ? "change" : frame.action;
  const noun = dup.instances.length === 1 ? "target" : "targets";
  return {
    key: "target_location",
    message: `${dup.instances.length} matching "${dup.phrase}" ${noun} — ${sectionSummary(dup.instances)}. Which should I ${verb}?`,
    choices: [
      ...dup.instances.map((l) => ({ title: l.label, value: l.value })),
      { title: "All of them", value: "__all__" },
    ],
    refine: (answer) => {
      if (!answer || answer.length === 0) return null;
      const n = dup.instances.length;
      if (answer.includes("__all__")) return `Apply the change to all ${n} identical "${dup.phrase}" occurrences.`;
      const picked = dup.instances.filter((i) => answer.includes(i.value));
      if (picked.length === 0) return null;
      const keep = dup.instances.filter((i) => !answer.includes(i.value));
      const targets = picked.map((i) => describeInstance(i, dup.phrase)).join(" and ");
      const keeps = keep.map((i) => describeInstance(i, dup.phrase)).join(", ");
      // The instances are identical copy, so a plain str_replace / find-replace
      // matches ALL of them. Tell the agent to disambiguate by surrounding
      // structure and expand the edit to target exactly the chosen one.
      return (
        `There are ${n} identical "${dup.phrase}" elements. Change ONLY ${targets}. ` +
        (keep.length ? `Do NOT touch ${keeps}. ` : "") +
        `Because the elements are byte-for-byte identical, a plain find-and-replace would hit all of them — ` +
        `locate the target by its surrounding markup (its enclosing element shown above) and include enough of that ` +
        `surrounding context in the edit to match exactly one element and leave the other copies unchanged.`
      );
    },
    scopeFor: (answer) => {
      if (!answer || answer.length === 0 || answer.includes("__all__")) return null; // nothing to protect
      const change = dup.instances.filter((i) => answer.includes(i.value));
      const keep = dup.instances.filter((i) => !answer.includes(i.value));
      if (change.length === 0 || keep.length === 0) return null;
      return { phrase: dup.phrase, change, keep };
    },
  };
}

// "This breaks N things — proceed?" The target is known; the question is
// whether the user accepts the blast radius (and whether the callers should be
// fixed too). "__cancel__" aborts the run.
function impactQuestion(frame: IntentFrame, impact: Impact): ClarifyQuestion {
  const where = impact.files.length ? ` across ${impact.files.length} other file${impact.files.length === 1 ? "" : "s"}` : "";
  const sample = impact.files.slice(0, 4).join(", ") + (impact.files.length > 4 ? ", …" : "");
  return {
    key: "impact_confirm",
    single: true,
    message: `${impact.target} is used in ${impact.refs} place${impact.refs === 1 ? "" : "s"}${where}${
      sample ? ` (${sample})` : ""
    }. A ${frame.action} will break them. Proceed?`,
    choices: [
      { title: `${frame.action} it AND update all call sites`, value: "__update__" },
      { title: `${frame.action} it only (I'll fix the callers)`, value: "__proceed__" },
      { title: "Cancel — leave it alone", value: "__cancel__" },
    ],
    refine: (answer) => {
      if (!answer || answer.length === 0 || answer.includes("__cancel__")) return null;
      if (answer.includes("__update__")) {
        return `${cap(frame.action)} ${impact.target} AND update every one of its ${impact.refs} call site${
          impact.refs === 1 ? "" : "s"
        }${impact.files.length ? ` (in ${impact.files.join(", ")})` : ""} so nothing is left broken.`;
      }
      return `${cap(frame.action)} ${impact.target} as asked. It is used in ${impact.refs} place${
        impact.refs === 1 ? "" : "s"
      } — this is intentional; leave updating those call sites to me.`;
    },
  };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Point the agent at one of several identical elements by its structural anchor. */
function describeInstance(i: Instance, phrase: string): string {
  return i.landmark
    ? `the "${phrase}" inside ${landmarkTag(i.landmark)} (${i.file} line ${i.line})`
    : `the "${phrase}" at ${i.file} line ${i.line}`;
}

function landmarkTag(landmark: string): string {
  if (landmark.includes("#")) {
    const [tag, id] = landmark.split("#");
    return `<${tag} id="${id}">`;
  }
  return `<${landmark}>`;
}

function styleContinuationNote(): string {
  return (
    "The visual styling isn't fully specified — continue the existing design rather than inventing new values: " +
    "reuse the colors, spacing, typography, radius, and variants already used by sibling elements and the project's design tokens."
  );
}

/**
 * Ask a set of prepared questions and return the refinement sentences. Ctrl-C
 * or an empty answer stops gracefully, keeping whatever was answered so far.
 */
export async function runQuestions(questions: ClarifyQuestion[]): Promise<ClarifyResult> {
  const refinements: string[] = [];
  let scope: EditScope | null = null;
  if (questions.length === 0) return { refinements, scope, cancelled: false };

  log.info("");
  log.dim("Quick check to target the change precisely (space = select, enter = confirm):");
  for (const q of questions) {
    const answer = await prompts({
      type: q.single ? "select" : "multiselect",
      name: q.key,
      message: q.message,
      choices: q.choices,
      instructions: false,
    });
    if (answer[q.key] === undefined) return { refinements, scope, cancelled: false }; // Ctrl-C — use what we have
    // Normalize select (single value) and multiselect (array) to one shape.
    const picked = q.single ? [answer[q.key] as string] : (answer[q.key] as string[]);
    if (picked.includes("__cancel__")) return { refinements, scope, cancelled: true };
    const line = q.refine(picked);
    if (line) {
      refinements.push(line);
      log.dim("  ✓ noted");
    }
    scope = q.scopeFor?.(picked) ?? scope;
  }
  return { refinements, scope, cancelled: false };
}

export function compileTask(task: string, refinements: string[]): string {
  if (refinements.length === 0) return task;
  return `${task}\n\nClarified details:\n${refinements.map((r) => `- ${r}`).join("\n")}`;
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
