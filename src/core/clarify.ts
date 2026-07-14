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

  // 1. Element ambiguity: "the button" when there are several buttons.
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

  // 2. File scope: several primary (edit-target) files, task names none of
  // them, and the ranking couldn't pick a clear winner. Supporting files are
  // context, not edit targets, so they don't drive this question.
  if (selection.primary.length >= 3) {
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

  // Trust the ranking when it's confident about the target — the whole point
  // of the ranking system is to decide quickly, not interrogate.
  if (rankingIsConfident(selection)) return refinements;

  const questions = await buildQuestions(task, selection, root);
  if (questions.length === 0) return refinements; // ranking uncertain but nothing concrete to ask

  log.info("");
  log.dim("The ranking wasn't sure which target you meant — one quick check (space = select, enter = confirm):");

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
