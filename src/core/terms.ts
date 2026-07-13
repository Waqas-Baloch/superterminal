// Task-term extraction shared by the ranking engine, selector, and manifest
// excerpting. Split out from selector.ts to avoid a circular import between
// selector.ts and core/ranking/*.

// Words that describe the request, not the code — they only add noise to the search.
export const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "them", "then", "than", "from", "into",
  "when", "where", "which", "what", "have", "has", "are", "was", "will", "would", "should",
  "add", "adds", "make", "makes", "create", "creates", "build", "builds", "implement",
  "update", "updates", "change", "changes", "fix", "fixes", "improve", "improves",
  "new", "use", "uses", "using", "show", "shows", "all", "can", "our", "its", "also",
]);

// Tiny domain synonym map for common web-app vocabulary. Deliberately small —
// BM25 over paths/symbols/content does the heavy lifting.
export const SYNONYMS: Record<string, string[]> = {
  checkout: ["cart", "order", "payment", "billing"],
  cart: ["checkout", "basket", "order"],
  payment: ["stripe", "billing", "checkout", "invoice"],
  auth: ["login", "signup", "session", "signin"],
  login: ["auth", "session", "signin"],
  form: ["input", "field", "validation", "submit"],
  home: ["index", "landing", "hero"],
  button: ["btn", "cta"],
  user: ["account", "profile"],
  api: ["route", "endpoint", "handler"],
  db: ["database", "prisma", "schema", "model"],
  style: ["css", "theme", "tailwind"],
  nav: ["navbar", "header", "menu", "sidebar"],
  modal: ["dialog", "popup", "overlay"],
  search: ["filter", "query"],
  email: ["mail", "notification"],
};

export function expandTask(task: string): string[] {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const out = new Set(words);
  for (const w of words) for (const syn of SYNONYMS[w] ?? []) out.add(syn);
  return [...out];
}

export function tokenizePath(p: string): string {
  return p
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((seg) => seg.split(/(?=[A-Z])/))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Raw (non-stopword-filtered, non-synonym-expanded) words — used for exact-match detection. */
export function rawTaskWords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}
