import nodePath from "node:path";
import type { RepoGraph } from "../mapper";
import type { RepoIndex } from "../indexer";
import type { Candidate, ScoreBreakdown, TaskProfile, UnitLevel } from "./types";
import { LEVEL_BASE, H_MODIFIERS } from "./weights";

const DOM_EXTS = new Set([".html", ".htm", ".css", ".scss"]);

const SURFACE_PATTERNS: RegExp[] = [
  /(^|\/)app\/.*\/page\.(tsx?|jsx?)$/,
  /(^|\/)pages\/api\//,
  /(^|\/)app\/api\/.*\/route\.(ts|js)$/,
  /(^|\/)pages\/(?!_app|_document)[^/]+\.(tsx?|jsx?)$/,
  /(^|\/)routes?\//i,
  /\.route\.(ts|js)$/,
  /(^|\/)api\//i,
  /(^|\/)(worker|jobs?)\//i,
  /(worker|job)\.(ts|js)$/i,
  /(^|\/)(main|server)\.(ts|js)$/,
  /controller\.(ts|js)$/i,
];

const CONFIG_PATTERNS = /(^|\/)(config|settings|constants|env)(\.|\/)/i;
const GENERATED_PATTERNS = /\.d\.ts$|(^|\/)__generated__\/|\.generated\.|(^|\/)migrations?\/.*\d{8,}/i;
const TEST_PATTERNS = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\//i;
const SCHEMA_PATTERNS = /schema\.prisma$|(^|\/)(schemas?|contracts?)\//i;

/**
 * Classify which unit level a candidate best represents, given the task's
 * anchor hints. A file whose exports/DOM-symbols exactly match an anchor
 * hint is treated as that precise unit (Symbol for code, Property for
 * markup/style); otherwise it falls back to Surface/Component by path shape.
 */
export function classifyLevel(
  path: string,
  ext: string,
  graph: RepoGraph,
  anchorHints: string[],
): { level: UnitLevel; matchedSymbol?: string } {
  const node = graph.nodes.get(path);
  const symbols = node?.exports ?? [];
  const normalizedHints = anchorHints.map(normalize);
  for (const sym of symbols) {
    if (normalizedHints.includes(normalize(sym))) {
      return { level: DOM_EXTS.has(ext) ? "property" : "symbol", matchedSymbol: sym };
    }
  }
  // Property-unit anchors in code files: JSX prop values / quoted strings
  // like label="Checkout" — often the only place a task's wording appears.
  for (const literal of node?.stringLiterals ?? []) {
    if (normalizedHints.includes(normalize(literal))) {
      return { level: "property", matchedSymbol: literal };
    }
  }
  if (SURFACE_PATTERNS.some((re) => re.test(path))) return { level: "surface" };
  return { level: "component" };
}

/** H — Hierarchy: base prior by level, adjusted by task-type modifier, clamped [0,1]. */
export function computeH(level: UnitLevel, taskType: TaskProfile["taskType"]): number {
  const base = LEVEL_BASE[level];
  const modifier = H_MODIFIERS[taskType]?.[level] ?? 0;
  return clamp01(base + modifier);
}

/**
 * M — Semantic Match. Spec: 0.45*BM25 + 0.35*EmbedSim + 0.20*ExactMatchBoost.
 * No embeddings in a local-first CLI with no guaranteed API key — EmbedSim's
 * weight is redistributed proportionally across the two signals we do have,
 * so M still spans [0,1] using only BM25 + exact-match detection.
 */
export function computeM(candidate: Candidate, bm25: number, anchorHints: string[]): number {
  const exact = exactMatchBoost(candidate, anchorHints);
  return 0.692 * bm25 + 0.308 * exact;
}

export function exactMatchBoost(candidate: Candidate, anchorHints: string[]): number {
  const normalizedHints = anchorHints.map(normalize);
  const base = normalize(nodePath.basename(candidate.path, nodePath.extname(candidate.path)));
  if (candidate.matchedSymbol && normalizedHints.includes(normalize(candidate.matchedSymbol))) return 1.0;
  if (normalizedHints.includes(base)) return 1.0;
  if (normalizedHints.some((h) => h.length > 2 && (base.includes(h) || h.includes(base)))) return 0.6;
  return 0;
}

export interface DependencyContext {
  graph: RepoGraph;
  anchorPaths: string[];
  maxDegree: number;
}

/** D — Dependency: direct/reverse edges to anchors, structural centrality, shared flow. */
export function computeD(path: string, ctx: DependencyContext): number {
  const node = ctx.graph.nodes.get(path);
  if (!node) return 0;

  let directEdge = 0;
  let reverseEdge = 0;
  let sharedFlow = 0;
  for (const anchorPath of ctx.anchorPaths) {
    const anchor = ctx.graph.nodes.get(anchorPath);
    if (!anchor) continue;
    if (anchor.imports.includes(path)) directEdge = Math.max(directEdge, 1);
    else if (anchor.imports.some((i) => ctx.graph.nodes.get(i)?.imports.includes(path))) directEdge = Math.max(directEdge, 0.5);
    if (node.imports.includes(anchorPath)) reverseEdge = Math.max(reverseEdge, 1);
    else if (node.imports.some((i) => ctx.graph.nodes.get(i)?.imports.includes(anchorPath))) reverseEdge = Math.max(reverseEdge, 0.5);
    if (node.imports.some((i) => anchor.imports.includes(i))) sharedFlow = 1;
  }

  const degree = node.imports.length + node.importedBy.length;
  const centrality = ctx.maxDegree > 0 ? Math.min(1, degree / ctx.maxDegree) : 0;

  return 0.4 * directEdge + 0.3 * reverseEdge + 0.2 * centrality + 0.1 * sharedFlow;
}

/** O — Ownership: does this unit define/control the thing the task targets? */
export function computeO(candidate: Candidate, graph: RepoGraph): number {
  const node = graph.nodes.get(candidate.path);
  const originMatch = candidate.level === "symbol" || candidate.level === "property" ? 1 : 0.3;
  const upstreamControl = node && node.imports.length + node.importedBy.length > 0
    ? clamp01(node.importedBy.length / (node.imports.length + node.importedBy.length + 1))
    : 0;
  const configAuthority = CONFIG_PATTERNS.test(candidate.path) || SCHEMA_PATTERNS.test(candidate.path) ? 1 : 0;
  const mutationLikelihood = /types?\//i.test(candidate.path) || candidate.path.endsWith(".d.ts") ? 0.2 : 0.6;
  return 0.35 * originMatch + 0.3 * upstreamControl + 0.2 * configAuthority + 0.15 * mutationLikelihood;
}

export interface ProximityContext {
  graph: RepoGraph;
  anchorPaths: string[];
  distances: Map<string, number>; // precomputed BFS distances from the anchor set
}

/** P — Proximity: graph distance to the nearest anchor + directory similarity. */
export function computeP(path: string, ctx: ProximityContext): number {
  const dist = ctx.distances.get(path) ?? Infinity;
  const pRaw = Number.isFinite(dist) ? 1 / (1 + dist) : 0;

  let bestDirSim = 0;
  const segs = path.split("/").slice(0, -1);
  for (const anchorPath of ctx.anchorPaths) {
    const aSegs = anchorPath.split("/").slice(0, -1);
    let common = 0;
    while (common < segs.length && common < aSegs.length && segs[common] === aSegs[common]) common++;
    const sim = Math.max(segs.length, aSegs.length) > 0 ? common / Math.max(segs.length, aSegs.length, 1) : 0;
    bestDirSim = Math.max(bestDirSim, sim);
  }

  return 0.65 * pRaw + 0.35 * bestDirSim;
}

export interface VerificationContext {
  testImporters: Set<string>; // files imported by at least one test file
  centrality01: number; // 0-1, reused from D's centrality calc
}

/** V — Verification: is this unit safety-critical, covered by tests, or regression-risky? */
export function computeV(candidate: Candidate, ctx: VerificationContext, taskType: TaskProfile["taskType"]): number {
  const safetyCritical = TEST_PATTERNS.test(candidate.path) || SCHEMA_PATTERNS.test(candidate.path) ? 1 : 0;
  const coverageLink = ctx.testImporters.has(candidate.path) ? 1 : 0;
  const regressionSensitive = taskType === "logic" || taskType === "api" || taskType === "data";
  const regressionRisk = regressionSensitive ? ctx.centrality01 : ctx.centrality01 * 0.3;
  return 0.6 * safetyCritical + 0.25 * coverageLink + 0.15 * regressionRisk;
}

export interface NoiseContext {
  duplicateHashes: Set<string>; // hashes that appear on more than one file
  hitDensity: number; // task-term hits found in content, roughly per 500 tokens
}

/** N — Noise Penalty: generated/duplicate/low-utility/token-wasteful candidates get pushed down. */
export function computeN(candidate: Candidate, index: RepoIndex, ctx: NoiseContext): number {
  const file = index.files.find((f) => f.path === candidate.path);
  const generated = GENERATED_PATTERNS.test(candidate.path) ? 1 : 0;
  const duplicate = file && ctx.duplicateHashes.has(file.hash) ? 1 : 0;
  const lowUtility = isBarrelFile(candidate) ? 1 : 0;
  const tokenWaste = clamp01(1 - ctx.hitDensity);
  return 0.4 * generated + 0.25 * duplicate + 0.2 * lowUtility + 0.15 * tokenWaste;
}

function isBarrelFile(candidate: Candidate): boolean {
  // Heuristic only, refined later with real content in rank.ts if needed.
  return /(^|\/)index\.(ts|js)x?$/.test(candidate.path) && candidate.tokens < 150;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
