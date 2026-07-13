import { STOPWORDS, rawTaskWords } from "../terms";
import type { TaskProfile, TaskScope, TaskType } from "./types";

// Stage A: infer task type, scope, and anchor hints from the task text alone —
// no repo lookup yet. Keyword buckets are deliberately small; ties are broken
// by the order below (earlier = more specific intent wins over vaguer ones).
const TYPE_KEYWORDS: [TaskType, string[]][] = [
  ["test", ["test", "tests", "testing", "spec", "e2e", "coverage", "assert", "mock"]],
  ["infra", ["deploy", "deployment", "docker", "pipeline", "infra", "infrastructure", "hosting", "ci", "cd"]],
  ["config", ["config", "configuration", "env", "environment", "setting", "settings", "flag"]],
  ["api", ["api", "endpoint", "route", "request", "response", "fetch", "webhook", "graphql", "rest"]],
  ["data", ["database", "db", "schema", "migration", "query", "column", "record", "entity", "model"]],
  ["copy", ["copy", "wording", "label", "text", "string", "headline", "title", "translate", "rename", "message"]],
  ["style", ["color", "colour", "css", "style", "styling", "theme", "font", "spacing", "margin", "padding", "background", "border", "responsive", "dark mode"]],
  ["logic", ["bug", "broken", "error", "crash", "logic", "calculate", "algorithm", "validate", "condition", "handle"]],
  ["ui", ["button", "click", "modal", "dialog", "form", "input", "layout", "page", "screen", "component", "render", "toggle", "dropdown", "menu", "nav", "sidebar", "icon", "card", "list", "table"]],
];

const SCOPE_KEYWORDS: [TaskScope, string[]][] = [
  ["cross-cutting", ["everywhere", "all pages", "global", "throughout", "site-wide", "sitewide", "across", "every page"]],
  ["flow", ["flow", "process", "onboarding", "checkout", "signup flow", "journey", "wizard", "multi-step"]],
];

export function classifyTask(task: string): TaskProfile {
  const lower = task.toLowerCase();
  const hitCounts = TYPE_KEYWORDS.map(([type, words]) => ({
    type,
    hits: words.filter((w) => lower.includes(w)).length,
  })).filter((r) => r.hits > 0);

  let taskType: TaskType = "ui"; // safest generic default — most tasks touch UI-adjacent files
  let classifierConfidence = 0.3; // nothing matched — low-confidence default
  if (hitCounts.length > 0) {
    hitCounts.sort((a, b) => b.hits - a.hits);
    taskType = hitCounts[0].type;
    const top = hitCounts[0].hits;
    const runnerUp = hitCounts[1]?.hits ?? 0;
    // Clear winner with no close competitor → high confidence; a near-tie
    // between two categories → the task is genuinely ambiguous.
    classifierConfidence = runnerUp === 0 ? Math.min(1, 0.65 + top * 0.1) : Math.min(1, 0.5 + (top - runnerUp) * 0.1);
  }

  let scope: TaskScope = "component";
  for (const [s, words] of SCOPE_KEYWORDS) {
    if (words.some((w) => lower.includes(w))) {
      scope = s;
      break;
    }
  }
  // A task naming one specific, narrow thing (short + has an anchor hint) reads as local scope.
  const anchorHints = extractAnchorHints(task);
  if (scope === "component" && anchorHints.length > 0 && task.trim().split(/\s+/).length <= 8) {
    scope = "local";
  }

  return { taskType, scope, classifierConfidence, anchorHints };
}

/**
 * Pull explicit anchor tokens out of the raw task text: quoted strings,
 * file-like tokens, route/selector-like tokens, and identifier-cased words.
 * Falls back to the top content words when nothing explicit is present.
 */
function extractAnchorHints(task: string): string[] {
  const hints = new Set<string>();

  for (const m of task.matchAll(/["']([^"']{2,40})["']/g)) hints.add(m[1].toLowerCase());
  for (const m of task.matchAll(/\b[\w-]+\.\w{2,4}\b/g)) hints.add(m[0].toLowerCase()); // file-like: foo.tsx
  for (const m of task.matchAll(/[#.][a-zA-Z][\w-]*/g)) hints.add(m[0].slice(1).toLowerCase()); // #id / .class
  for (const m of task.matchAll(/\/[a-zA-Z][\w/-]*/g)) hints.add(m[0].toLowerCase()); // /route/path
  for (const m of task.matchAll(/\b[a-z]+(?:[A-Z][a-z]*)+\b|\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b/g)) {
    hints.add(m[0].toLowerCase()); // camelCase / PascalCase identifiers
  }

  if (hints.size === 0) {
    for (const w of rawTaskWords(task)) {
      if (w.length > 2 && !STOPWORDS.has(w)) hints.add(w);
      if (hints.size >= 3) break;
    }
  }
  return [...hints];
}
