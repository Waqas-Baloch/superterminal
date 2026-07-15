import { execa } from "execa";
import { spin } from "../report/spinner";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_CLIS, pathWithLocalBin, type AgentCliDef } from "../claude/agentCli";
import { loadGlobalConfig, saveGlobalConfig, type AgentCliId } from "../util/globalConfig";
import { log } from "../util/logger";

export type ProviderId = "api-key" | "oauth" | AgentCliId;

export function providerLabel(id: string): string {
  if (id === "api-key") return "Anthropic API key";
  if (id === "oauth") return "Anthropic browser login";
  return AGENT_CLIS[id as AgentCliId]?.title ?? id;
}

export async function detectAvailability(): Promise<{ hasAnt: boolean; installed: Record<string, boolean> }> {
  const agents = Object.values(AGENT_CLIS);
  const [hasAnt, ...flags] = await Promise.all([binExists("ant"), ...agents.map((a) => binExists(a.bin))]);
  const installed: Record<string, boolean> = {};
  agents.forEach((a, i) => (installed[a.id] = flags[i]));
  return { hasAnt, installed };
}

export function providerChoices(opts: {
  hasAnt: boolean;
  installed: Record<string, boolean>;
  current?: string;
}): { title: string; description: string; value: string; disabled?: boolean }[] {
  const mark = (id: string) => (opts.current === id ? pc.green("  (current)") : "");
  return [
    {
      title: `Anthropic API key${mark("api-key")}`,
      description: "paste once, stored locally in ~/.glint (permissions 600)",
      value: "api-key",
    },
    {
      title: `${opts.hasAnt ? "Browser login (Anthropic CLI)" : "Browser login — requires the `ant` CLI"}${mark("oauth")}`,
      description: opts.hasAnt
        ? "no key to manage — opens your browser via `ant auth login`"
        : "install first: brew install anthropics/tap/ant",
      value: "oauth",
      disabled: !opts.hasAnt,
    },
    ...Object.values(AGENT_CLIS).map((a) => ({
      title: `${a.title}${opts.installed[a.id] ? "" : " — not installed yet"}${mark(a.id)}`,
      description: opts.installed[a.id] ? `${a.billingNote}; via \`${a.bin}\`` : `I can install it (${a.installCmd})`,
      value: a.id,
    })),
  ];
}

/**
 * Set up and save the chosen provider. Instant when the agent CLI is already
 * installed and logged in (its auth lives outside Glint). Preserves any stored
 * API key across switches so switching back to it is also instant.
 */
export async function applyProvider(provider: ProviderId): Promise<boolean> {
  const existing = await loadGlobalConfig();

  if (provider === "api-key") {
    let key = existing?.apiKey;
    if (key) {
      const { reuse } = await prompts({ type: "confirm", name: "reuse", message: "Reuse your saved API key?", initial: true });
      if (reuse === undefined) return false;
      if (!reuse) key = undefined;
    }
    if (!key) {
      const r = await prompts({ type: "password", name: "key", message: "Paste your Anthropic API key (console.anthropic.com):" });
      key = r.key;
    }
    if (!key) {
      log.info("Cancelled — nothing saved.");
      return false;
    }
    if (!(await verify(new Anthropic({ apiKey: key })))) return false;
    await saveGlobalConfig({ provider: "api-key", apiKey: key });
    log.success("Using Anthropic API key.");
    return true;
  }

  if (provider === "oauth") {
    if (!(await binExists("ant"))) {
      log.error("Browser login needs the `ant` CLI. Install: brew install anthropics/tap/ant");
      return false;
    }
    let ok = await verify(new Anthropic(), { quiet: true }); // maybe already logged in → instant
    if (!ok) {
      log.info("Opening browser login…");
      const login = await execa("ant", ["auth", "login"], { stdio: "inherit", reject: false });
      if (login.exitCode !== 0) {
        log.error("`ant auth login` did not complete.");
        return false;
      }
      ok = await verify(new Anthropic());
    }
    if (!ok) return false;
    await saveGlobalConfig({ provider: "oauth", apiKey: existing?.apiKey });
    log.success("Using Anthropic browser login.");
    return true;
  }

  const agent = AGENT_CLIS[provider as AgentCliId];
  if (!(await binExists(agent.bin))) {
    if (!(await installAgent(agent))) return false;
    await loginAgent(agent);
  }
  await saveGlobalConfig({ provider: agent.id, apiKey: existing?.apiKey });
  log.success(`Using ${agent.title} — via your \`${agent.bin}\` login.`);
  return true;
}

async function verify(client: Anthropic, opts?: { quiet?: boolean }): Promise<boolean> {
  const spinner = opts?.quiet ? null : spin("Verifying credentials…").start();
  try {
    await client.models.retrieve("claude-opus-4-8"); // free metadata call — no tokens billed
    spinner?.succeed("Credentials verified");
    return true;
  } catch (err) {
    spinner?.fail(`Verification failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return false;
  }
}

async function installAgent(agent: AgentCliDef): Promise<boolean> {
  const { go } = await prompts({
    type: "confirm",
    name: "go",
    message: `${agent.title} CLI isn't installed. Install it now? (${agent.installCmd})`,
    initial: true,
  });
  if (!go) {
    log.info(`Skipped. Install manually — ${agent.installHint} — then rerun.`);
    return false;
  }
  log.info(pc.dim(`$ ${agent.installCmd}`));
  const result = await execa(agent.installCmd, {
    shell: true,
    stdio: "inherit",
    reject: false,
    timeout: 600_000,
    env: { ...process.env, PATH: pathWithLocalBin() },
  });
  if (result.exitCode !== 0 || !(await binExists(agent.bin))) {
    log.error(`Install did not complete (${agent.bin} still not found).`);
    if (agent.id === "codex") {
      log.info("Global npm can need elevated permissions — try `brew install codex` or `sudo npm i -g @openai/codex`.");
    }
    log.info(`Manual route: ${agent.installHint}`);
    return false;
  }
  log.success(`${agent.title} CLI installed`);
  return true;
}

async function loginAgent(agent: AgentCliDef): Promise<void> {
  if (!agent.loginArgs) {
    log.warn(`One step left before your first run: ${agent.loginHint}.`);
    return;
  }
  log.info(`Opening ${agent.title} login…`);
  const result = await execa(agent.bin, agent.loginArgs, {
    stdio: "inherit",
    reject: false,
    timeout: 600_000,
    env: { ...process.env, PATH: pathWithLocalBin() },
  });
  if (result.exitCode !== 0) {
    log.warn(`Login didn't complete — ${agent.loginHint} before your first run.`);
  }
}

async function binExists(cmd: string): Promise<boolean> {
  try {
    const result = await execa(cmd, ["--version"], {
      reject: false,
      timeout: 10_000,
      env: { ...process.env, PATH: pathWithLocalBin() },
    });
    return result.exitCode !== undefined;
  } catch {
    return false;
  }
}
