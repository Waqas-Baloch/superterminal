import type { SeedFile } from "./selector";

/** What the session remembers between tasks — the fuel for follow-up mode. */
export interface SessionMemory {
  task: string;
  touched: string[];
  summary: string;
}

// Short tasks and referential language ("make it darker") lean on the
// previous task for meaning.
const FOLLOWUP_HINTS =
  /\b(it|that|those|them|this|also|too|again|instead|same|previous|last|other|rest|undo|more|less|bigger|smaller|darker|lighter|brighter)\b/i;

export function isFollowUp(task: string, memory: SessionMemory | undefined): boolean {
  if (!memory) return false;
  return task.trim().split(/\s+/).length <= 7 || FOLLOWUP_HINTS.test(task);
}

/**
 * Seed the next selection with the previous task's files. Follow-ups get a
 * strong score (they're almost certainly about the same files); unrelated new
 * tasks get a weak one — enough to ride along as signatures, not enough to
 * crowd out the new task's own matches.
 */
export function seedsFrom(task: string, memory: SessionMemory | undefined): SeedFile[] {
  if (!memory) return [];
  const followUp = isFollowUp(task, memory);
  return memory.touched.map((path) => ({
    path,
    score: followUp ? 0.65 : 0.2,
    reason: followUp ? "follow-up: edited in previous task" : "context: edited in previous task",
  }));
}

/** Compact note for the manifest so "make it darker" resolves correctly (~100-300 tokens). */
export function buildSessionNote(memory: SessionMemory | undefined): string | undefined {
  if (!memory) return undefined;
  const summary = memory.summary.length > 400 ? `${memory.summary.slice(0, 397)}…` : memory.summary;
  return [
    `Previous task in this session: ${memory.task.split("\n")[0]}`,
    memory.touched.length > 0 ? `Files changed by it: ${memory.touched.join(", ")}` : "",
    summary ? `Outcome: ${summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
