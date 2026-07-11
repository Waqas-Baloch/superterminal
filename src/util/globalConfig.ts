import { promises as fs } from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { z } from "zod";

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

/** User-level config dir (GLINT_HOME override is for tests). */
export function glintHome(): string {
  return process.env.GLINT_HOME ?? nodePath.join(os.homedir(), ".glint");
}

function configFile(): string {
  return nodePath.join(glintHome(), "config.json");
}

export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    return schema.parse(JSON.parse(await fs.readFile(configFile(), "utf8")));
  } catch {
    // pre-rebrand fallback: connections made as `squash` keep working.
    // Skipped when GLINT_HOME is overridden (tests need isolation).
    if (process.env.GLINT_HOME) return null;
    try {
      const legacy = nodePath.join(os.homedir(), ".squash", "config.json");
      return schema.parse(JSON.parse(await fs.readFile(legacy, "utf8")));
    } catch {
      return null;
    }
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<string> {
  await fs.mkdir(glintHome(), { recursive: true });
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
 * so power users and CI keep working without `glint connect`.
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
    return { mode: "api-key", apiKey: config.apiKey, source: "stored key (glint connect)" };
  }
  if (config?.provider === "oauth") {
    return { mode: "oauth", source: "Anthropic browser login (ant profile)" };
  }
  if (config?.provider === "claude-code" || config?.provider === "cursor" || config?.provider === "codex") {
    return { mode: "agent-cli", agent: config.provider, source: AGENT_SOURCES[config.provider] };
  }
  return null;
}
