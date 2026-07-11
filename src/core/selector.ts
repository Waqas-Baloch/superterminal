import { promises as fs } from "node:fs";
import nodePath from "node:path";
import MiniSearch from "minisearch";
import type { RepoIndex } from "./indexer";
import type { RepoGraph } from "./mapper";
import { estimateTokens } from "../util/tokens";

export interface SelectedFile {
  path: string;
  score: number;
  tokens: number;
  reasons: string[];
}

export interface Selection {
  task: string;
  primary: SelectedFile[]; // sent as full content
  secondary: SelectedFile[]; // sent as signatures only
  totalTokens: number;
  budget: number;
}

export interface SeedFile {
  path: string;
  score: number;
  reason: string;
}

// Tiny domain synonym map for common web-app vocabulary. Deliberately small —
// BM25 over paths/symbols/content does the heavy lifting.
const SYNONYMS: Record<string, string[]> = {
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

const BOOST_PATTERNS: { re: RegExp; score: number; reason: string }[] = [
  { re: /(^|\/)schema\.prisma$/, score: 0.35, reason: "database schema" },
  { re: /(^|\/)(schemas?|models?|types?)\//, score: 0.15, reason: "schema/type directory" },
  { re: /tailwind\.config\.(js|ts)$/, score: 0.2, reason: "theme config" },
];

// package.json / tsconfig facts go in the manifest header — never spend selection budget on them
const EXCLUDE_FROM_SELECTION = new Set(["package.json", "tsconfig.json"]);

const MAX_PRIMARY_FILES = 15;
const PRIMARY_SHARE = 0.7; // of budget
const SECONDARY_SHARE = 0.2; // of budget; remainder reserved for manifest framing
const SIGNATURE_TOKEN_CAP = 200;
const MIN_SCORE = 0.05;
// Files scoring below this fraction of the top hit are never sent in full —
// they matched (e.g. shared nav-bar vocabulary) but are not what the task is
// about. They ride along as signatures at most.
const RELATIVE_CUTOFF = 0.3;
const INDEXED_CONTENT_CAP = 16_384; // chars per file fed to the search index

export async function selectFiles(opts: {
  task: string;
  root: string;
  index: RepoIndex;
  graph: RepoGraph;
  budget: number;
  seeds?: SeedFile[]; // session follow-up: files from the previous task
}): Promise<Selection> {
  const { task, root, index, graph, budget } = opts;

  const contents = new Map<string, string>();
  for (const f of index.files) {
    const text = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => "");
    contents.set(f.path, text);
  }

  const mini = new MiniSearch({ fields: ["pathTerms", "symbols", "content"] });
  mini.addAll(
    index.files.map((f) => ({
      id: f.path,
      pathTerms: tokenizePath(f.path),
      symbols: graph.nodes.get(f.path)?.exports.join(" ") ?? "",
      content: (contents.get(f.path) ?? "").slice(0, INDEXED_CONTENT_CAP),
    })),
  );

  const hits = mini.search(expandTask(task).join(" "), {
    prefix: true,
    fuzzy: 0.15,
    boost: { pathTerms: 4, symbols: 3, content: 1 },
  });

  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const maxScore = hits[0]?.score ?? 1;
  for (const hit of hits) {
    const cleanTerms = hit.terms.filter((t) => /^[\w-]+$/.test(t)).slice(0, 4);
    scores.set(hit.id, {
      score: hit.score / maxScore,
      reasons: new Set([`matched: ${cleanTerms.join(", ") || "content"}`]),
    });
  }

  // One hop along the import graph from the strongest hits: a matched page
  // drags in its components/hooks/api client even if they share no vocabulary.
  for (const hit of hits.slice(0, 10)) {
    const node = graph.nodes.get(hit.id);
    if (!node) continue;
    const spread = (hit.score / maxScore) * 0.4;
    for (const neighbor of [...node.imports, ...node.importedBy]) {
      const existing = scores.get(neighbor);
      if (existing) {
        existing.score = Math.max(existing.score, spread);
        existing.reasons.add(`linked to ${hit.id}`);
      } else {
        scores.set(neighbor, { score: spread, reasons: new Set([`linked to ${hit.id}`]) });
      }
    }
  }

  for (const f of index.files) {
    for (const boost of BOOST_PATTERNS) {
      if (!boost.re.test(f.path)) continue;
      const existing = scores.get(f.path);
      if (existing) {
        existing.score += boost.score;
        existing.reasons.add(boost.reason);
      } else {
        scores.set(f.path, { score: boost.score, reasons: new Set([boost.reason]) });
      }
    }
  }

  for (const seed of opts.seeds ?? []) {
    if (!contents.has(seed.path)) continue; // file may have been deleted since
    const existing = scores.get(seed.path);
    if (existing) {
      existing.score = Math.max(existing.score, seed.score);
      existing.reasons.add(seed.reason);
    } else {
      scores.set(seed.path, { score: seed.score, reasons: new Set([seed.reason]) });
    }
  }

  const ranked = [...scores.entries()]
    .filter(([path]) => !EXCLUDE_FROM_SELECTION.has(path))
    .map(([path, s]) => ({
      path,
      score: s.score,
      reasons: [...s.reasons],
      tokens: estimateTokens(contents.get(path) ?? ""),
    }))
    .filter((f) => f.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const primary: SelectedFile[] = [];
  const secondary: SelectedFile[] = [];
  let primaryTokens = 0;
  let secondaryTokens = 0;
  const primaryThreshold = (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF;

  for (const f of ranked) {
    if (
      f.score >= primaryThreshold &&
      primary.length < MAX_PRIMARY_FILES &&
      primaryTokens + f.tokens <= budget * PRIMARY_SHARE
    ) {
      primary.push(f);
      primaryTokens += f.tokens;
    } else {
      const sigTokens = Math.min(f.tokens, SIGNATURE_TOKEN_CAP);
      if (secondaryTokens + sigTokens <= budget * SECONDARY_SHARE) {
        secondary.push({ ...f, tokens: sigTokens });
        secondaryTokens += sigTokens;
      }
    }
  }

  return { task, primary, secondary, totalTokens: primaryTokens + secondaryTokens, budget };
}

/** Tiny-project fallback: when nothing matches but the whole repo fits comfortably, send it all. */
export function fullSelection(task: string, index: RepoIndex, budget: number): Selection {
  const files = index.files
    .filter((f) => !EXCLUDE_FROM_SELECTION.has(f.path))
    .map((f) => ({
      path: f.path,
      score: 1,
      tokens: estimateTokens(f.size),
      reasons: ["small project — sending full context"],
    }));
  return { task, primary: files, secondary: [], totalTokens: files.reduce((s, f) => s + f.tokens, 0), budget };
}

function tokenizePath(p: string): string {
  return p
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((seg) => seg.split(/(?=[A-Z])/))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Words that describe the request, not the code — they only add noise to the search.
export const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "them", "then", "than", "from", "into",
  "when", "where", "which", "what", "have", "has", "are", "was", "will", "would", "should",
  "add", "adds", "make", "makes", "create", "creates", "build", "builds", "implement",
  "update", "updates", "change", "changes", "fix", "fixes", "improve", "improves",
  "new", "use", "uses", "using", "show", "shows", "all", "can", "our", "its", "also",
]);

export function expandTask(task: string): string[] {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const out = new Set(words);
  for (const w of words) for (const syn of SYNONYMS[w] ?? []) out.add(syn);
  return [...out];
}
