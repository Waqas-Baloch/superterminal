import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { statePath, stateDir, STATE_DIR } from "./paths";

const configSchema = z.object({
  model: z.string().default("claude-opus-4-8"),
  // One safety dial for every agent: safe (no shell/network tools), standard
  // (each agent's sandboxed default), full (agent-native "skip permissions" —
  // explicit opt-in only).
  mode: z.enum(["safe", "standard", "full"]).default("standard"),
  // Second Opinion: a DIFFERENT vendor reviews every accepted diff. Also
  // settable as a `review: codex` line in any rules file.
  reviewer: z.enum(["claude-code", "cursor", "codex"]).optional(),
  // Pin which ticket tracker `super-t ticket` uses in this repo (a project can
  // have a GitHub remote while the team plans in Jira).
  tracker: z.enum(["github", "linear", "jira"]).optional(),
  budgetTokens: z.number().int().positive().default(30_000),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof configSchema>;

const CONFIG_FILE = "config.json"; // lives in the state dir with everything else

/**
 * Update the project's config, preserving every other setting. Refuses to
 * touch a file that exists but won't parse — overwriting it would silently
 * discard mode, reviewer, budget and the rest.
 */
export async function updateProjectConfig(
  root: string,
  mutate: (c: Record<string, unknown>) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = statePath(root, CONFIG_FILE);
  let config: Record<string, unknown> = {};
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  if (existing !== null) {
    try {
      config = JSON.parse(existing);
    } catch {
      return { ok: false, error: `${STATE_DIR}/${CONFIG_FILE} isn't valid JSON — fix it first so your other settings aren't lost.` };
    }
  }
  mutate(config);
  await fs.mkdir(stateDir(root), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
  return { ok: true };
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(root, CONFIG_FILE), "utf8");
  } catch {
    return configSchema.parse({});
  }
  try {
    return configSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`Invalid ${STATE_DIR}/${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
