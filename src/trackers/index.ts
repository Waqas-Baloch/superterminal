import type { TrackerAdapter } from "./types";
import { githubTracker } from "./github";
import { linearTracker } from "./linear";
import { jiraTracker } from "./jira";

// Registry, in the order we try them: GitHub rides `gh`; Linear and Jira are
// paste-a-token adapters (tokens: home dir only, 0600 — protocol T3).
export const TRACKERS: TrackerAdapter[] = [githubTracker, linearTracker, jiraTracker];

export interface TrackerAvailability {
  usable: TrackerAdapter[];
  reasons: string[]; // why each unusable tracker isn't, for a clear error
}

/**
 * Every tracker usable in this repo — not just the first. Someone with GitHub,
 * Linear and Jira connected has work in all three; showing only the first
 * hides the rest (and looked like a bug when a deliberately connected tracker
 * lost to one that qualified from ambient state).
 *
 * Probes run concurrently: each adapter does subprocess or network checks, and
 * doing three sets in series made `ticket` sit silent before showing anything.
 *
 * `prefer` (project config `tracker:`) still narrows to exactly one — an
 * explicit pin is a deliberate choice and stays authoritative.
 */
export async function usableTrackers(root: string, prefer?: TrackerAdapter["id"]): Promise<TrackerAvailability> {
  const candidates = prefer ? TRACKERS.filter((t) => t.id === prefer) : TRACKERS;
  const checked = await Promise.all(
    candidates.map(async (adapter) => ({ adapter, verdict: await adapter.available(root).catch((e: unknown) => String(e)) })),
  );
  const usable: TrackerAdapter[] = [];
  const reasons: string[] = [];
  for (const { adapter, verdict } of checked) {
    if (verdict === true) usable.push(adapter);
    else reasons.push(`${adapter.title}: ${verdict}`);
  }
  return { usable, reasons };
}
