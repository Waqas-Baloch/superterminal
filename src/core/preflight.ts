import { promises as fs } from "node:fs";
import nodePath from "node:path";

// Preflight target-existence check. Glint's whole promise is spending fewer
// tokens — so a destructive/modify edit to something that isn't in the repo
// should never reach the agent. The agent would just burn tokens rediscovering
// that nothing matches. If every specific target the task names is absent from
// every source file, stop before sending.

const MODIFY_ACTIONS = new Set(["remove", "hide", "move", "rename", "restyle", "duplicate", "connect"]);
const MAX_SCAN_BYTES = 8_000_000; // above this the repo is too big to check confidently — skip

export function isModifyAction(action: string): boolean {
  return MODIFY_ACTIONS.has(action);
}

/**
 * The *specific* things a task names — high precision only, so a generic word
 * like "button" is never treated as a target that must exist:
 *   • quoted phrases            → "Upgrade to Pro"
 *   • code identifiers          → formatPrice, get_user, UserService
 *   • multi-word Capitalized copy → Upgrade to Pro, Try Now
 */
export function targetDescriptors(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/["'“”‘’]([^"'“”‘’]{2,50})["'“”‘’]/g)) {
    const v = m[1].trim();
    if (v.length >= 3) out.add(v);
  }
  for (const m of task.matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:[A-Z]|_)[A-Za-z0-9]+)\b/g)) {
    if (m[1].length >= 3) out.add(m[1]);
  }
  const conn = "(?:to|of|the|a|an|for|and|or|on|in|up|with|&)";
  for (const m of task.matchAll(new RegExp(`\\b([A-Z][a-z]+(?:\\s+(?:${conn}\\s+)?[A-Z][a-z]+)+)\\b`, "g"))) {
    out.add(m[1].replace(/\s+/g, " ").trim());
  }
  return [...out];
}

/**
 * Which of the named descriptors appear NOWHERE in the given files. Returns
 * null when the repo is too large to scan confidently (stay silent rather than
 * risk a false "not found"). An empty array means every target was located.
 */
export async function findMissingTargets(
  root: string,
  files: { path: string; size: number }[],
  descriptors: string[],
): Promise<string[] | null> {
  if (descriptors.length === 0) return [];
  if (files.reduce((s, f) => s + f.size, 0) > MAX_SCAN_BYTES) return null;

  const missing = new Set(descriptors.map((d) => d.toLowerCase()));
  const display = new Map(descriptors.map((d) => [d.toLowerCase(), d]));
  for (const f of files) {
    if (missing.size === 0) break;
    const lower = (await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => "")).toLowerCase();
    for (const key of [...missing]) if (lower.includes(key)) missing.delete(key);
  }
  return [...missing].map((k) => display.get(k)!);
}
