import { promises as fs } from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { z } from "zod";
import { homeDir, homeCandidates } from "./paths";

export type AgentCliId = "claude-code" | "cursor" | "codex";

const AGENT_SOURCES: Record<AgentCliId, string> = {
  "claude-code": "Claude Code CLI",
  cursor: "Cursor CLI",
  codex: "Codex CLI (ChatGPT)",
};

const schema = z.object({
  provider: z.enum(["api-key", "oauth", "claude-code", "cursor", "codex"]),
  apiKey: z.string().optional(),
});

export type GlobalConfig = z.infer<typeof schema>;

/** User-level config dir. Re-exported so callers don't reach past this module. */
export { homeDir as glintHome } from "./paths";

function configFile(): string {
  return nodePath.join(homeDir(), "config.json");
}

export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  // Current location first, then every earlier brand's. A connection made
  // under an old name keeps working instead of silently asking for setup again.
  for (const candidate of homeCandidates("config.json")) {
    try {
      return schema.parse(JSON.parse(await fs.readFile(candidate, "utf8")));
    } catch {
      continue;
    }
  }
  return null;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<string> {
  await fs.mkdir(homeDir(), { recursive: true });
  const file = configFile();
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export type Auth =
  | { mode: "api-key"; apiKey: string; source: string }
  | { mode: "oauth"; source: string }
  | { mode: "agent-cli"; agent: AgentCliId; source: string };

/**
 * Resolution order: explicit env vars beat the stored connection,
 * so power users and CI keep working without `super-t connect`.
 */
export async function resolveAuth(): Promise<Auth | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: "api-key", apiKey: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY env var" };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { mode: "oauth", source: "ANTHROPIC_AUTH_TOKEN env var" };
  }
  const config = await loadGlobalConfig();
  if (config?.provider === "api-key" && config.apiKey) {
    return { mode: "api-key", apiKey: config.apiKey, source: "stored key (super-t connect)" };
  }
  if (config?.provider === "oauth") {
    return { mode: "oauth", source: "Anthropic browser login (ant profile)" };
  }
  if (config?.provider === "claude-code" || config?.provider === "cursor" || config?.provider === "codex") {
    return { mode: "agent-cli", agent: config.provider, source: AGENT_SOURCES[config.provider] };
  }
  return null;
}
