import { execa } from "execa";
import type { RepoIndex } from "../indexer";

const HALF_LIFE_DAYS = 14; // a file edited today scores ~1.0, ~2 weeks ago ~0.5
const LOG_COMMIT_LIMIT = 200; // bounded so this stays fast even on old repos
const GIT_TIMEOUT_MS = 4000;

/**
 * R — Recency/Co-edit. Spec: 0.50*CoEditFrequency + 0.30*RecentChangeBoost +
 * 0.20*PRCoupling. PRCoupling needs a PR system Super Terminal doesn't integrate with
 * (a local CLI has no GitHub/GitLab API wired up) and stays at 0 — a minor
 * sub-signal of an already-small top-level weight (w_R=0.06), so it isn't
 * redistributed like M's EmbedSim is. RecentChangeBoost uses filesystem
 * mtime (always available); CoEditFrequency uses a bounded `git log` and
 * degrades to 0 outside a git repo or if git isn't installed.
 */
export async function computeRecencySignals(root: string, index: RepoIndex, anchorPaths: string[]): Promise<Map<string, number>> {
  const recency = recencyFromMtime(index);
  const coEdit = await coEditFromGitLog(root, anchorPaths);

  const out = new Map<string, number>();
  for (const f of index.files) {
    const r = 0.5 * (coEdit.get(f.path) ?? 0) + 0.3 * (recency.get(f.path) ?? 0);
    out.set(f.path, r);
  }
  return out;
}

function recencyFromMtime(index: RepoIndex): Map<string, number> {
  const out = new Map<string, number>();
  const newest = Math.max(...index.files.map((f) => f.mtimeMs), 0);
  const halfLifeMs = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  for (const f of index.files) {
    const ageMs = Math.max(0, newest - f.mtimeMs);
    out.set(f.path, Math.exp((-Math.LN2 * ageMs) / halfLifeMs));
  }
  return out;
}

async function coEditFromGitLog(root: string, anchorPaths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (anchorPaths.length === 0) return out;

  const result = await execa(
    "git",
    ["log", "--relative", `-n`, String(LOG_COMMIT_LIMIT), "--name-only", "--pretty=format:%x01"],
    { cwd: root, reject: false, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return out; // not a git repo, git missing, or timed out

  const anchorSet = new Set(anchorPaths);
  const commits = result.stdout.split("\x01").map((block) => block.split("\n").map((l) => l.trim()).filter(Boolean));

  const counts = new Map<string, number>();
  for (const files of commits) {
    if (!files.some((f) => anchorSet.has(f))) continue;
    for (const f of files) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  for (const [path, count] of counts) out.set(path, count / max);
  return out;
}
