import type { RankedFile, ScoreBreakdown } from "./types";
import { combineScore, type DEFAULT_WEIGHTS } from "./weights";
import { expansionMultiplier } from "./anchors";
import { clamp01 } from "./signals";

export interface ScoredCandidate {
  path: string;
  breakdown: Omit<ScoreBreakdown, "C">;
  depth: number;
  tokens: number;
  reasons: string[];
}

/**
 * Confidence (C) is computed once per ranking run, not per candidate — its
 * three sub-signals (classifier confidence, anchor agreement, rank margin)
 * are all global properties of this ranking, not of an individual unit.
 * rankMargin needs a preliminary sort, which is why this is a 2-pass flow:
 * rank.ts scores everything with C=0 first, calls this to get the scalar,
 * then re-scores with the real C baked into every candidate's breakdown.
 */
export function computeGlobalConfidence(
  classifierConfidence: number,
  anchorAgreement: number,
  candidatesSortedByRawScore: { rawScore: number }[],
): number {
  const top = candidatesSortedByRawScore[0]?.rawScore ?? 0;
  const runnerUp = candidatesSortedByRawScore[1]?.rawScore ?? 0;
  const rankMargin = top > 0 ? clamp01((top - runnerUp) / top) : 0;
  return clamp01(0.5 * classifierConfidence + 0.3 * anchorAgreement + 0.2 * rankMargin);
}

const TIER_BUDGET_SHARE = { primary: 0.6, supporting: 0.3, optional: 0.1 };
const TIER_MAX_FILES = { primary: 15, supporting: 15, optional: 20 };
// Depth 0 = anchor unit; depth 1 = owner/direct deps/direct consumers;
// depth 2+ = siblings/tests/schemas — this is exactly the spec's own
// Candidate Expansion depth semantics, so tiers fall out of depth directly.
function tierForDepth(depth: number): "primary" | "supporting" | "optional" {
  if (depth === 0) return "primary";
  if (depth === 1) return "supporting";
  return "optional";
}

export interface PackedTiers {
  primary: RankedFile[];
  supporting: RankedFile[];
  optional: RankedFile[];
  totalTokens: number;
}

/**
 * Finalize S(u|q) with the real confidence score, apply the expansion decay
 * to get S'(u|q), partition into tiers by depth, then pack each tier by
 * utility density U(u) = S'(u|q) / TokenCost(u) until its budget slice fills.
 */
export function packBudget(
  candidates: ScoredCandidate[],
  weights: typeof DEFAULT_WEIGHTS,
  confidence: number,
  budget: number,
): PackedTiers {
  const finalized = candidates.map((c) => {
    const breakdown: ScoreBreakdown = { ...c.breakdown, C: confidence };
    const rawScore = combineScore(breakdown, weights);
    const score = rawScore * expansionMultiplier(c.depth);
    return { ...c, breakdown, score, utility: c.tokens > 0 ? score / c.tokens : score };
  });

  const buckets = { primary: [] as typeof finalized, supporting: [] as typeof finalized, optional: [] as typeof finalized };
  for (const f of finalized) buckets[tierForDepth(f.depth)].push(f);

  let totalTokens = 0;
  const pack = (tier: keyof typeof buckets): RankedFile[] => {
    const tierBudget = budget * TIER_BUDGET_SHARE[tier];
    // Order by raw relevance first; utility density only breaks ties between
    // near-equal scores. Pure density-first packing lets trivially cheap
    // files (a 40-token constants file) crowd out a larger, genuinely more
    // relevant one purely for being cheaper — sound reasoning for
    // fine-grained symbol/property units, but file-level token costs vary
    // too widely for cost-efficiency to override actual relevance.
    const sorted = [...buckets[tier]].sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.02) return scoreDiff;
      return b.utility - a.utility;
    });
    const out: RankedFile[] = [];
    let used = 0;
    for (const c of sorted) {
      if (out.length >= TIER_MAX_FILES[tier]) break;
      if (used + c.tokens > tierBudget && out.length > 0) continue; // skip if it doesn't fit; a smaller lower-priority file might
      out.push({ path: c.path, score: c.score, breakdown: c.breakdown, depth: c.depth, tokens: c.tokens, reasons: c.reasons });
      used += c.tokens;
    }
    totalTokens += used;
    return out;
  };

  return { primary: pack("primary"), supporting: pack("supporting"), optional: pack("optional"), totalTokens };
}
