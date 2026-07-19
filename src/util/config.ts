import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { statePath, STATE_DIR } from "./paths";

const configSchema = z.object({
  model: z.string().default("claude-opus-4-8"),
  budgetTokens: z.number().int().positive().default(30_000),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof configSchema>;

const CONFIG_FILE = "config.json"; // lives in the state dir with everything else

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
