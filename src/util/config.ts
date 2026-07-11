import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const configSchema = z.object({
  model: z.string().default("claude-opus-4-8"),
  budgetTokens: z.number().int().positive().default(30_000),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export type GlintConfig = z.infer<typeof configSchema>;

export async function loadConfig(root: string): Promise<GlintConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, ".glintrc.json"), "utf8");
  } catch {
    try {
      raw = await fs.readFile(path.join(root, ".squashrc.json"), "utf8"); // pre-rebrand fallback
    } catch {
      return configSchema.parse({});
    }
  }
  try {
    return configSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`Invalid .glintrc.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}
