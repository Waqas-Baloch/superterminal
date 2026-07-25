import type { TrackerAdapter } from "./types";
import { githubTracker } from "./github";

// Registry, in the order we try them. Linear and Jira join as paste-a-token
// adapters (tokens: home dir only, 0600 — protocol T3).
export const TRACKERS: TrackerAdapter[] = [githubTracker];

/** The first tracker usable in this repo, or every reason none is. */
export async function resolveTracker(root: string): Promise<{ adapter: TrackerAdapter } | { reasons: string[] }> {
  const reasons: string[] = [];
  for (const adapter of TRACKERS) {
    const a = await adapter.available(root);
    if (a === true) return { adapter };
    reasons.push(`${adapter.title}: ${a}`);
  }
  return { reasons };
}
