import type { TrackerAdapter } from "./types";
import { githubTracker } from "./github";
import { linearTracker } from "./linear";
import { jiraTracker } from "./jira";

// Registry, in the order we try them: GitHub rides `gh`; Linear and Jira are
// paste-a-token adapters (tokens: home dir only, 0600 — protocol T3).
export const TRACKERS: TrackerAdapter[] = [githubTracker, linearTracker, jiraTracker];

/**
 * The tracker to use in this repo, or every reason none is usable.
 * `prefer` (project config `tracker:`) pins one instead of first-wins — a repo
 * can have a GitHub remote AND its team on Jira.
 */
export async function resolveTracker(
  root: string,
  prefer?: TrackerAdapter["id"],
): Promise<{ adapter: TrackerAdapter } | { reasons: string[] }> {
  const candidates = prefer ? TRACKERS.filter((t) => t.id === prefer) : TRACKERS;
  const reasons: string[] = [];
  for (const adapter of candidates) {
    const a = await adapter.available(root);
    if (a === true) return { adapter };
    reasons.push(`${adapter.title}: ${a}`);
  }
  return { reasons };
}
