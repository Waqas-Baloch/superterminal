import { execa } from "execa";
import ora from "ora";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_CLIS, pathWithLocalBin, type AgentCliDef } from "../claude/agentCli";
import { saveGlobalConfig, type AgentCliId } from "../util/globalConfig";
import { log } from "../util/logger";

export async function connectCommand(): Promise<void> {
  log.info(pc.bold("Connect Glint to your AI — one-time setup."));
  log.info("");

  const agents = Object.values(AGENT_CLIS);
  const [hasAnt, ...agentInstalled] = await Promise.all([
    binExists("ant"),
    ...agents.map((a) => binExists(a.bin)),
  ]);

  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "How do you want to connect?",
    choices: [
      {
        title: "Anthropic API key",
        description: "paste once, stored locally in ~/.glint (permissions 600)",
        value: "api-key",
      },
      {
        title: hasAnt ? "Browser login (Anthropic CLI)" : "Browser login — requires the `ant` CLI",
        description: hasAnt
          ? "no key to manage — opens your browser via `ant auth login`"
          : "install first: brew install anthropics/tap/ant",
        value: "oauth",
        disabled: !hasAnt,
      },
      ...agents.map((a, i) => ({
        title: agentInstalled[i] ? a.title : `${a.title} — not installed yet`,
        description: agentInstalled[i]
          ? `${a.billingNote}; edits run through \`${a.bin}\``
          : `I can install it for you (${a.installCmd})`,
        value: a.id,
      })),
    ],
  });

  if (!provider) {
    log.info("Cancelled — nothing saved.");
    return;
  }

  if (provider === "api-key") {
    const { key } = await prompts({
      type: "password",
      name: "key",
      message: "Paste your Anthropic API key (from console.anthropic.com):",
    });
    if (!key) {
      log.info("Cancelled — nothing saved.");
      return;
    }
    if (!(await verify(new Anthropic({ apiKey: key })))) {
      process.exitCode = 1;
      return;
    }
    const file = await saveGlobalConfig({ provider: "api-key", apiKey: key });
    log.success(`Connected. Key stored in ${file}`);
  }

  if (provider === "oauth") {
    log.info("Opening browser login…");
    const login = await execa("ant", ["auth", "login"], { stdio: "inherit", reject: false });
    if (login.exitCode !== 0) {
      log.error("`ant auth login` did not complete.");
      process.exitCode = 1;
      return;
    }
    // Verify through the SDK itself — it reads the ant profile automatically.
    if (!(await verify(new Anthropic()))) {
      process.exitCode = 1;
      return;
    }
    await saveGlobalConfig({ provider: "oauth" });
    log.success("Connected via browser login — no key stored on disk.");
  }

  if (provider in AGENT_CLIS) {
    const agent = AGENT_CLIS[provider as AgentCliId];

    if (!(await binExists(agent.bin))) {
      if (!(await installAgent(agent))) {
        process.exitCode = 1;
        return;
      }
      await loginAgent(agent);
    }

    await saveGlobalConfig({ provider: agent.id });
    log.success(`Connected via ${agent.title} — runs use your \`${agent.bin}\` login.`);
    log.dim(`Note: with this provider, edits are applied by ${agent.title} inside a git repo; review/undo with git.`);
  }

  log.info("");
  log.info(`Try it: ${pc.bold('glint run "add a loading spinner to the submit button"')}`);
}

async function verify(client: Anthropic): Promise<boolean> {
  const spinner = ora("Verifying credentials…").start();
  try {
    await client.models.retrieve("claude-opus-4-8"); // free metadata call — no tokens billed
    spinner.succeed("Credentials verified");
    return true;
  } catch (err) {
    spinner.fail(
      `Verification failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
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
    log.info(`Skipped. Install manually — ${agent.installHint} — then rerun \`glint connect\`.`);
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
    return result.exitCode !== undefined; // ran at all (even if the flag is unsupported)
  } catch {
    return false;
  }
}
