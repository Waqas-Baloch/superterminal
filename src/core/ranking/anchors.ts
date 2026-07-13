import type { RepoGraph } from "../mapper";
import type { Anchor, Candidate, TaskProfile } from "./types";
import { exactMatchBoost, clamp01 } from "./signals";

const ANCHOR_LIMIT = 6;
const ANCHOR_RELATIVE_CUTOFF = 0.35; // anchors scoring below this fraction of the top anchor are dropped
// A relative-only cutoff breaks down when the top score itself is tiny (e.g.
// several files tie at the bare InteractionContext floor with no real
// Explicitness/StringMatch evidence) — everything within 35% of a near-zero
// top score still passes. This absolute floor rejects that whole tied batch
// instead of anchoring on noise.
export const ANCHOR_ABSOLUTE_MIN = 0.15;
const EXPANSION_DECAY = 0.7; // spec: E(depth) = exp(-0.7*depth)
const DEFAULT_MAX_DEPTH = 2;
const LOW_CONFIDENCE_MAX_DEPTH = 3; // spec: "depth 3+ only if confidence is low or task is cross-cutting"

/**
 * A(u) = 0.40*Explicitness + 0.30*StringMatch + 0.20*StructuralMatch + 0.10*InteractionContext.
 * InteractionContext has no real proxy in a CLI with no runtime click
 * telemetry — approximated by how precise the unit's matched level is
 * (symbol/property/surface implies a specific located thing; a bare
 * component-level hit is weaker evidence of "this is the interaction point").
 */
export function computeAnchorScore(candidate: Candidate, taskProfile: TaskProfile): number {
  const explicitness = candidate.matchedSymbol && taskProfile.anchorHints.some((h) => normalize(h) === normalize(candidate.matchedSymbol!)) ? 1 : 0;
  const stringMatch = exactMatchBoost(candidate, taskProfile.anchorHints);
  const routeHints = taskProfile.anchorHints.filter((h) => h.startsWith("/"));
  const structuralMatch =
    routeHints.length > 0 && routeHints.some((h) => candidate.path.toLowerCase().includes(h))
      ? 1
      : candidate.level === "surface" || candidate.level === "symbol"
        ? 0.3
        : 0;
  const interactionContext = candidate.level === "component" ? 0.5 : 1;

  return clamp01(0.4 * explicitness + 0.3 * stringMatch + 0.2 * structuralMatch + 0.1 * interactionContext);
}

/** Seed Stage B from the highest-confidence anchor units among the initial (depth-0) candidates. */
export function pickAnchors(candidates: Candidate[], taskProfile: TaskProfile): Anchor[] {
  const scored = candidates
    .map((c) => ({ path: c.path, score: computeAnchorScore(c, taskProfile) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const threshold = Math.max(top * ANCHOR_RELATIVE_CUTOFF, ANCHOR_ABSOLUTE_MIN);
  return scored.filter((a) => a.score >= threshold).slice(0, ANCHOR_LIMIT);
}

/** How deep Stage B should expand — the spec's depth-3+ escape hatch for low-confidence/cross-cutting tasks. */
export function maxExpansionDepth(taskProfile: TaskProfile): number {
  return taskProfile.classifierConfidence < 0.45 || taskProfile.scope === "cross-cutting"
    ? LOW_CONFIDENCE_MAX_DEPTH
    : DEFAULT_MAX_DEPTH;
}

/** E(depth) = exp(-0.7*depth) — the expansion multiplier applied to S(u|q) to get S'(u|q). */
export function expansionMultiplier(depth: number): number {
  return Math.exp(-EXPANSION_DECAY * depth);
}

/**
 * BFS over the import graph (both directions) from the anchor set, capped at
 * maxDepth. Doubles as the GraphDistance input for Proximity (P) and the
 * depth input for the expansion multiplier (E) — the spec's "depth" and
 * "graph distance" are the same underlying traversal.
 */
export function bfsDepths(graph: RepoGraph, anchorPaths: string[], maxDepth: number): Map<string, number> {
  const distances = new Map<string, number>();
  let frontier = anchorPaths.filter((p) => graph.nodes.has(p));
  for (const p of frontier) distances.set(p, 0);

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      const node = graph.nodes.get(path);
      if (!node) continue;
      for (const neighbor of [...node.imports, ...node.importedBy]) {
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, depth);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return distances;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
