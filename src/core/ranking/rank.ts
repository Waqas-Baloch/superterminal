import { promises as fs } from "node:fs";
import nodePath from "node:path";
import MiniSearch from "minisearch";
import type { RepoIndex } from "../indexer";
import type { RepoGraph } from "../mapper";
import { expandTask, tokenizePath } from "../terms";
import { estimateTokens } from "../../util/tokens";
import { classifyTask } from "./taskProfile";
import { weightsFor } from "./weights";
import {
  classifyLevel,
  computeH,
  computeM,
  computeD,
  computeO,
  computeP,
  computeN,
  computeV,
  clamp01,
  type DependencyContext,
  type ProximityContext,
  type VerificationContext,
  type NoiseContext,
} from "./signals";
import { pickAnchors, bfsDepths, maxExpansionDepth } from "./anchors";
import { computeRecencySignals } from "./gitSignals";
import { computeGlobalConfidence, packBudget, type ScoredCandidate } from "./budget";
import type { Candidate, RankedSelection, SeedFile } from "./types";

const EXCLUDE_FROM_RANKING = new Set(["package.json", "tsconfig.json"]);
const INDEXED_CONTENT_CAP = 16_384;
const MIN_FINAL_SCORE = 0.03;
const TEST_PATTERN = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\//i;

export interface RankOptions {
  task: string;
  root: string;
  index: RepoIndex;
  graph: RepoGraph;
  budget: number;
  seeds?: SeedFile[];
}

/**
 * Full pipeline from the Glint Context Ranking Specification: Stage A (task
 * classification) → anchor detection → Stage B (depth-based graph expansion)
 * → weighted 9-signal scoring → confidence finalization → tiered budget pack.
 */
export async function rankContext(opts: RankOptions): Promise<RankedSelection> {
  const { task, root, index, graph, budget } = opts;
  const taskProfile = classifyTask(task);
  const weights = weightsFor(taskProfile.taskType);

  const contents = new Map<string, string>();
  for (const f of index.files) {
    contents.set(f.path, await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => ""));
  }

  // Initial candidate pool via BM25 (same search substrate as before — this
  // becomes the M/StringMatch evidence the anchor and H/O logic builds on).
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
  const maxBm25 = hits[0]?.score ?? 1;
  const bm25 = new Map<string, number>(hits.map((h) => [h.id, h.score / maxBm25]));
  for (const seed of opts.seeds ?? []) bm25.set(seed.path, Math.max(bm25.get(seed.path) ?? 0, seed.score));

  const candidatePaths = new Set(bm25.keys());
  const candidates = new Map<string, Candidate>();
  for (const path of candidatePaths) {
    if (EXCLUDE_FROM_RANKING.has(path) || !contents.has(path)) continue;
    const { level, matchedSymbol } = classifyLevel(path, nodePath.extname(path), graph, taskProfile.anchorHints);
    candidates.set(path, { path, tokens: estimateTokens(contents.get(path) ?? ""), level, matchedSymbol });
  }

  // Seeds carry higher-confidence provenance than a fresh text match — we
  // *know* from session memory these files matter for continuity, so they're
  // forced anchors (depth 0, full content) rather than left to compete
  // through A(u) scoring like an ordinary candidate.
  let detectedAnchors = pickAnchors([...candidates.values()], taskProfile);
  const seedAnchors = (opts.seeds ?? [])
    .filter((s) => candidates.has(s.path))
    .map((s) => ({ path: s.path, score: s.score }));
  // Nothing cleared the anchor bar (no exact symbol/literal/structural
  // match) — rather than leave the run anchor-less, trust the strongest raw
  // text match directly. Scored modestly below ANCHOR_ABSOLUTE_MIN so it
  // reads as a soft fallback, not a confident anchor, in the final output.
  if (detectedAnchors.length === 0 && seedAnchors.length === 0) {
    const byBm25 = [...bm25.entries()].filter(([p]) => candidates.has(p)).sort((a, b) => b[1] - a[1]);
    detectedAnchors = byBm25.slice(0, 3).map(([path]) => ({ path, score: 0.1 }));
  }
  const anchors = dedupeAnchors([...seedAnchors, ...detectedAnchors]);
  const anchorPaths = anchors.map((a) => a.path);
  const maxDepth = maxExpansionDepth(taskProfile);
  const distances = bfsDepths(graph, anchorPaths, maxDepth);
  const seedReasons = new Map((opts.seeds ?? []).map((s) => [s.path, s.reason]));

  // Pull in graph-adjacent files the text search alone didn't surface —
  // Stage B's actual "expansion" beyond the anchor-seeded pool.
  for (const [path, depth] of distances) {
    if (candidates.has(path) || depth > maxDepth || EXCLUDE_FROM_RANKING.has(path)) continue;
    const content = contents.get(path);
    if (content === undefined) continue;
    const { level, matchedSymbol } = classifyLevel(path, nodePath.extname(path), graph, taskProfile.anchorHints);
    candidates.set(path, { path, tokens: estimateTokens(content), level, matchedSymbol });
  }

  // Shared context every per-candidate signal function needs, computed once.
  const maxDegree = Math.max(1, ...[...graph.nodes.values()].map((n) => n.imports.length + n.importedBy.length));
  const depContext: DependencyContext = { graph, anchorPaths, maxDegree };
  const proxContext: ProximityContext = { graph, anchorPaths, distances };
  const testImporters = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (TEST_PATTERN.test(node.path)) for (const imp of node.imports) testImporters.add(imp);
  }
  const hashCounts = new Map<string, number>();
  for (const f of index.files) hashCounts.set(f.hash, (hashCounts.get(f.hash) ?? 0) + 1);
  const duplicateHashes = new Set([...hashCounts].filter(([, n]) => n > 1).map(([h]) => h));

  const recency = await computeRecencySignals(root, index, anchorPaths);

  const anchorSet = new Set(anchorPaths);
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates.values()) {
    // Anchors are depth 0; graph-confirmed neighbors get their real BFS
    // distance; a text-only match with no graph relationship to any anchor
    // falls back to depth 2 ("optional"/signatures), matching the spec's own
    // depth-2 examples (schemas, tests, siblings) rather than being treated
    // as a confirmed direct dependency it never was.
    const depth = anchorSet.has(candidate.path) ? 0 : (distances.get(candidate.path) ?? 2);
    const centrality01 = clamp01(
      (graph.nodes.get(candidate.path)?.imports.length ?? 0) + (graph.nodes.get(candidate.path)?.importedBy.length ?? 0) / maxDegree,
    );
    const verifCtx: VerificationContext = { testImporters, centrality01 };
    const hitDensity = termHitDensity(contents.get(candidate.path) ?? "", taskProfile.anchorHints, candidate.tokens);
    const noiseCtx: NoiseContext = { duplicateHashes, hitDensity };

    const breakdown = {
      H: computeH(candidate.level, taskProfile.taskType),
      M: computeM(candidate, bm25.get(candidate.path) ?? 0, taskProfile.anchorHints),
      D: computeD(candidate.path, depContext),
      O: computeO(candidate, graph),
      P: computeP(candidate.path, proxContext),
      R: recency.get(candidate.path) ?? 0,
      V: computeV(candidate, verifCtx, taskProfile.taskType),
      N: computeN(candidate, index, noiseCtx),
    };
    const seedReason = seedReasons.get(candidate.path);
    const reasons = buildReasons(candidate, breakdown, depth, anchorSet);
    scored.push({
      path: candidate.path,
      breakdown,
      depth,
      tokens: candidate.tokens,
      reasons: seedReason ? [seedReason, ...reasons] : reasons,
    });
  }

  // Two-pass confidence: rank once without C to get the margin, then bake the
  // real (global) confidence into every candidate for the final score.
  const withoutC = scored
    .map((c) => ({ ...c, rawScore: weightedSumWithoutC(c.breakdown, weights) }))
    .sort((a, b) => b.rawScore - a.rawScore);
  const anchorAgreement = anchors[0]?.score ?? 0;
  const confidence = computeGlobalConfidence(taskProfile.classifierConfidence, anchorAgreement, withoutC);

  const packed = packBudget(scored, weights, confidence, budget);
  const filterMin = (files: typeof packed.primary) => files.filter((f) => f.score >= MIN_FINAL_SCORE);

  return {
    taskProfile,
    anchors,
    primary: filterMin(packed.primary),
    supporting: filterMin(packed.supporting),
    optional: filterMin(packed.optional),
    totalTokens: packed.totalTokens,
    budget,
  };
}

function dedupeAnchors(anchors: { path: string; score: number }[]): { path: string; score: number }[] {
  const byPath = new Map<string, number>();
  for (const a of anchors) byPath.set(a.path, Math.max(byPath.get(a.path) ?? 0, a.score));
  return [...byPath.entries()].map(([path, score]) => ({ path, score }));
}

function weightedSumWithoutC(breakdown: Omit<import("./types").ScoreBreakdown, "C">, weights: ReturnType<typeof weightsFor>): number {
  return (
    weights.H * breakdown.H +
    weights.M * breakdown.M +
    weights.D * breakdown.D +
    weights.O * breakdown.O +
    weights.P * breakdown.P +
    weights.R * breakdown.R +
    weights.V * breakdown.V -
    weights.N * breakdown.N
  );
}

function termHitDensity(content: string, anchorHints: string[], tokens: number): number {
  if (!content || anchorHints.length === 0) return 0;
  const lower = content.toLowerCase();
  const hits = anchorHints.reduce((n, h) => n + (h.length > 1 && lower.includes(h.toLowerCase()) ? 1 : 0), 0);
  return clamp01(hits / Math.max(1, tokens / 500));
}

function buildReasons(
  candidate: Candidate,
  breakdown: Omit<import("./types").ScoreBreakdown, "C">,
  depth: number,
  anchors: Set<string>,
): string[] {
  const reasons: string[] = [];
  if (anchors.has(candidate.path)) reasons.push(candidate.matchedSymbol ? `anchor: ${candidate.matchedSymbol}` : "anchor match");
  else if (candidate.matchedSymbol) reasons.push(`matches: ${candidate.matchedSymbol}`);
  const top = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0.5) reasons.push(`strong ${SIGNAL_LABEL[top[0]] ?? top[0]}`);
  if (depth > 0) reasons.push(`${depth} hop${depth > 1 ? "s" : ""} from anchor`);
  if (reasons.length === 0) reasons.push(`${candidate.level} match`);
  return reasons;
}

const SIGNAL_LABEL: Record<string, string> = {
  H: "hierarchy fit",
  M: "text match",
  D: "dependency link",
  O: "ownership",
  P: "proximity",
  R: "recent edit",
  V: "verification value",
};
