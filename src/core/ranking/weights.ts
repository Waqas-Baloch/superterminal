import type { ScoreBreakdown, TaskType, UnitLevel } from "./types";

/** Default weights from the spec's Scoring Formula section. */
export const DEFAULT_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  H: 0.14,
  M: 0.22,
  D: 0.2,
  O: 0.18,
  P: 0.08,
  R: 0.06,
  V: 0.07,
  C: 0.05,
  N: 0.12, // subtracted, not added — see combineScore()
};

// Mode presets: task types that "emphasize" a set of components get that
// component's weight boosted (spec: "Copy mode: emphasize M and O", etc.).
// Modest, documented multiplier — the spec doesn't fix an exact magnitude.
const EMPHASIS = 1.25;
const MODE_PRESETS: Partial<Record<TaskType, (keyof ScoreBreakdown)[]>> = {
  copy: ["M", "O"],
  style: ["H", "D", "O", "P"],
  ui: ["H", "D", "O", "P"],
  logic: ["D", "O"],
  data: ["D", "O", "V"],
  api: ["D", "O", "V"],
};

export function weightsFor(taskType: TaskType): Record<keyof ScoreBreakdown, number> {
  const emphasized = MODE_PRESETS[taskType];
  if (!emphasized) return DEFAULT_WEIGHTS;
  const out = { ...DEFAULT_WEIGHTS };
  for (const key of emphasized) out[key] *= EMPHASIS;
  return out;
}

/** Combine the 9 normalized component scores into S(u|q) = Σ(w·x) − w_N·N. */
export function combineScore(breakdown: ScoreBreakdown, weights: Record<keyof ScoreBreakdown, number>): number {
  const positive =
    weights.H * breakdown.H +
    weights.M * breakdown.M +
    weights.D * breakdown.D +
    weights.O * breakdown.O +
    weights.P * breakdown.P +
    weights.R * breakdown.R +
    weights.V * breakdown.V +
    weights.C * breakdown.C;
  return Math.max(0, positive - weights.N * breakdown.N);
}

/** Hierarchy H base priors per unit level. */
export const LEVEL_BASE: Record<UnitLevel, number> = {
  surface: 0.45,
  component: 0.7,
  symbol: 1.0,
  property: 0.82,
};

// Task-type modifiers on H, from the spec's worked examples, extended
// consistently to every task type. Values are additive, then clamped [0,1].
export const H_MODIFIERS: Partial<Record<TaskType, Partial<Record<UnitLevel, number>>>> = {
  copy: { property: 0.12, symbol: -0.05 },
  style: { component: 0.08, property: 0.05 },
  logic: { symbol: 0.1, property: -0.1 },
  ui: { component: 0.06, symbol: 0.04 },
  data: { symbol: 0.08, surface: -0.05 },
  api: { surface: 0.1, symbol: 0.05 },
  config: { surface: 0.05, property: 0.1 },
  test: { symbol: 0.05 },
  infra: { surface: 0.15 },
};
