// Types for the Super Terminal Context Ranking Specification. See
// docs/ranking-spec.md for the source formulas this module implements.

export type TaskType = "ui" | "copy" | "logic" | "style" | "data" | "api" | "config" | "test" | "infra";
export type TaskScope = "local" | "component" | "flow" | "cross-cutting";

/** Stage A output: what the task is about, before any repo lookup happens. */
export interface TaskProfile {
  taskType: TaskType;
  scope: TaskScope;
  classifierConfidence: number; // [0,1] — how clearly the text signaled one type
  anchorHints: string[]; // explicit tokens pulled from the task (route/label/symbol-like)
}

/** Unit hierarchy level, per the spec's Context Units section. */
export type UnitLevel = "surface" | "component" | "symbol" | "property";

/** A file-level candidate carrying everything needed to score it. */
export interface Candidate {
  path: string;
  tokens: number;
  level: UnitLevel;
  matchedSymbol?: string; // exported symbol / DOM id-class that anchored this candidate at Symbol/Property level
}

/** The 9 raw component scores, each normalized to [0,1] before weighting. */
export interface ScoreBreakdown {
  H: number;
  M: number;
  D: number;
  O: number;
  P: number;
  R: number;
  V: number;
  C: number;
  N: number;
}

export interface RankedFile {
  path: string;
  score: number; // S'(u|q) after depth decay, before confidence finalization
  breakdown: ScoreBreakdown;
  depth: number;
  tokens: number;
  reasons: string[];
}

export interface Anchor {
  path: string;
  score: number; // A(u)
}

export interface RankedSelection {
  taskProfile: TaskProfile;
  anchors: Anchor[];
  primary: RankedFile[];
  supporting: RankedFile[];
  optional: RankedFile[];
  totalTokens: number;
  budget: number;
}

/** Session follow-up: a file from the previous task, injected as a synthetic candidate. */
export interface SeedFile {
  path: string;
  score: number;
  reason: string;
}
