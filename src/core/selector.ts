import type { RepoIndex } from "./indexer";
import type { RepoGraph } from "./mapper";
import { rankContext } from "./ranking/rank";
import type { TaskType, TaskScope, Anchor, SeedFile } from "./ranking/types";
import { estimateTokens } from "../util/tokens";

// Re-exported for existing callers (manifest.ts, clarify.ts, session.ts) —
// these utilities live in terms.ts to avoid a cycle with core/ranking/*.
export { expandTask, STOPWORDS } from "./terms";
export type { SeedFile } from "./ranking/types";

export interface SelectedFile {
  path: string;
  score: number;
  tokens: number;
  reasons: string[];
}

export interface Selection {
  task: string;
  primary: SelectedFile[]; // depth 0 — anchor units; sent as full content
  supporting: SelectedFile[]; // depth 1 — owner/deps/consumers; sent as full content
  optional: SelectedFile[]; // depth 2+ — siblings/tests/schemas; sent as signatures only
  totalTokens: number;
  budget: number;
  taskType: TaskType;
  taskConfidence: number;
  anchors: Anchor[];
}

// package.json / tsconfig facts go in the manifest header — never spend selection budget on them
const EXCLUDE_FROM_SELECTION = new Set(["package.json", "tsconfig.json"]);

/**
 * Select and rank repo context for a task, per the Super Terminal Context Ranking
 * Specification (see core/ranking/). Thin adapter: builds the graph-derived
 * candidate pool via rankContext(), then reshapes it into the Selection
 * type the CLI/manifest/UI layers consume.
 */
export async function selectFiles(opts: {
  task: string;
  root: string;
  index: RepoIndex;
  graph: RepoGraph;
  budget: number;
  seeds?: SeedFile[]; // session follow-up: files from the previous task
}): Promise<Selection> {
  const ranked = await rankContext(opts);
  return {
    task: opts.task,
    primary: ranked.primary.map(toSelectedFile),
    supporting: ranked.supporting.map(toSelectedFile),
    optional: ranked.optional.map(toSelectedFile),
    totalTokens: ranked.totalTokens,
    budget: ranked.budget,
    taskType: ranked.taskProfile.taskType,
    taskConfidence: ranked.taskProfile.classifierConfidence,
    anchors: ranked.anchors,
  };
}

function toSelectedFile(f: { path: string; score: number; tokens: number; reasons: string[] }): SelectedFile {
  return { path: f.path, score: f.score, tokens: f.tokens, reasons: f.reasons };
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
  return {
    task,
    primary: files,
    supporting: [],
    optional: [],
    totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    budget,
    taskType: "ui",
    taskConfidence: 1,
    anchors: [],
  };
}

export type { TaskType, TaskScope };
