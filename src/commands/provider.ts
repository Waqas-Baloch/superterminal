import { execa } from "execa";
import { spin } from "../report/spinner";
import pc from "picocolors";
import prompts from "prompts";
import Anthropic from "@anthropic-ai/sdk";
import {
  AGENT_CLIS,
  installCommandFor,
  installHintFor,
  isAgentInstalled,
  pathWithLocalBin,
  type AgentCliDef,
} from "../claude/agentCli";
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
      description: "paste once, stored locally in ~/.super-t (permissions 600)",
      value: "api-key",
    },
    {
      title: `${opts.hasAnt ? "Browser login (Anthropic CLI)" : "Browser login — requires the `ant` CLI"}${mark("oauth")}`,
      description: opts.hasAnt
        ? "no key to manage — opens your browser via `ant auth login`"
        : // `ant` ships through Homebrew, which is macOS/Linux. Naming a package
          // manager the user cannot have is the same wrong answer as a `curl |
          // bash` line on Windows — say what is actually true there instead.
          process.platform === "win32"
          ? "not available on Windows yet — use an API key or an agent below"
          : "install first: brew install anthropics/tap/ant",
      value: "oauth",
      disabled: !opts.hasAnt,
    },
    ...Object.values(AGENT_CLIS).map((a) => ({
      title: `${a.title}${opts.installed[a.id] ? "" : " — not installed yet"}${mark(a.id)}`,
      description: opts.installed[a.id]
        ? `${a.billingNote}; via \`${a.bin}\``
        : a.installArgs
          ? `I can install it (${installCommandFor(a)})`
          : // No installArgs means the vendor's method pipes a downloaded
            // script into a shell, which Super Terminal shows but will not run.
            // Offering "I can install it" there is a promise it then breaks.
            `you run: ${installCommandFor(a)}`,
      value: a.id,
    })),
  ];
}

/**
 * Set up and save the chosen provider. Instant when the agent CLI is already
 * installed and logged in (its auth lives outside Super Terminal). Preserves any stored
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

  // Installed is not the same as signed in, and this is where that used to be
  // assumed. Login previously ran ONLY inside the branch above — so anyone who
  // already had the CLI (the common case) skipped it entirely and was told
  // "Using Cursor — via your cursor-agent login" while cursor-agent was
  // reporting "Not logged in". Connect claimed success and the first real task
  // then failed on an auth error, with nothing connecting the two.
  if (await isSignedOut(agent)) {
    log.info("");
    log.warn(`${agent.title} is installed but not signed in.`);
    await loginAgent(agent);

    // Check again rather than assume the login took. A browser flow can be
    // closed, cancelled, or completed as the wrong account.
    if (await isSignedOut(agent)) {
      log.error(`Still not signed in to ${agent.title}. Nothing saved.`);
      log.dim(`  ${agent.loginHint}, then run \`super-t connect\` again.`);
      return false;
    }
  }

  await saveGlobalConfig({ provider: agent.id, apiKey: existing?.apiKey });
  log.success(`Using ${agent.title} — via your \`${agent.bin}\` login.`);
  return true;
}

/**
 * Is this agent's CLI unusable — missing, or installed and logged out?
 *
 * Exit codes are useless for the logged-out half: `cursor-agent status` exits 0
 * while printing "Not logged in". So the probe matches the negative signal in
 * the text, and an unrecognized response counts as signed in rather than
 * raising a false alarm.
 *
 * That leniency is the whole design, and it is only safe once "the CLI isn't
 * there" has been ruled out first — otherwise the shell's own error text is
 * just another unrecognized response, and connect green-lights an agent the
 * machine has never had.
 */
export async function isSignedOut(agent: AgentCliDef): Promise<boolean> {
  if (!agent.authProbe) return false; // nothing to check against
  // Resolved in Node, so the answer is the same on every platform: a CLI that
  // is not on PATH cannot be signed in, whatever a shell would print when asked
  // to run it. Windows is why this comes first — there, spawning a missing
  // command goes through cmd.exe, which answers with an ordinary exit code and
  // a "not recognized" line that looks nothing like "not logged in".
  if (!(await isAgentInstalled(agent.bin))) return true;
  const r = await execa(agent.bin, agent.authProbe.args, {
    reject: false,
    timeout: 15_000,
    env: { ...process.env, PATH: pathWithLocalBin() },
  }).catch(() => null);
  // "Assume signed in" is the right answer to a reply we don't recognize. It is
  // the wrong answer to no reply at all: a probe that never started says the
  // CLI isn't runnable, and calling that signed in is how connect certified an
  // agent that wasn't installed. Only a spawn failure counts here — a timeout
  // or a signal must not push someone through a login they don't need.
  if (!r || r.code === "ENOENT") return true;
  // Never log this — `claude auth status` returns the account email and org id.
  return agent.authProbe.loggedOut.test(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
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
  // Two very different cases, and only one is ours to run.
  //
  // `npm install -g …` is a plain command: we can execute it as an argument
  // array, with no shell involved at all.
  //
  // The others are the vendors' own `curl … | bash` (`irm … | iex` on Windows).
  // A pipe needs a shell, and piping a downloaded script into a shell means
  // whoever controls that URL controls this machine. That is the vendors'
  // documented method and it may well be fine — but Super Terminal will not be
  // the thing that runs remote code for you. We print it; you decide.
  //
  // Whatever we print has to be runnable in the shell the user is actually in.
  const cmd = installCommandFor(agent);
  if (!agent.installArgs) {
    log.info("");
    log.info(`${agent.title} installs with the vendor's own script:`);
    log.info(`  ${pc.bold(cmd)}`);
    if (process.platform === "win32") log.dim("  (PowerShell — not cmd.exe)");
    log.dim("  That downloads a script and runs it. Super Terminal won't run remote code for you —");
    log.dim("  copy the line above, run it yourself, then rerun `super-t connect`.");
    return false;
  }

  const { go } = await prompts({
    type: "confirm",
    name: "go",
    message: `${agent.title} CLI isn't installed. Install it now? (${cmd})`,
    initial: true,
  });
  if (!go) {
    log.info(`Skipped. Install manually — ${installHintFor(agent)} — then rerun.`);
    return false;
  }
  log.info(pc.dim(`$ ${cmd}`));
  const [bin, ...rest] = agent.installArgs;
  const result = await execa(bin, rest, {
    stdio: "inherit",
    reject: false,
    timeout: 600_000,
    env: { ...process.env, PATH: pathWithLocalBin() },
  });
  if (result.exitCode !== 0 || !(await binExists(agent.bin))) {
    log.error(`Install did not complete (${agent.bin} still not found).`);
    // A failed global npm install is nearly always the npm prefix being
    // unwritable. The remedy differs per vendor — Anthropic explicitly warns
    // against `sudo npm i -g` for Claude Code — so name the cause and let the
    // per-platform hint carry the alternative rather than guessing one here.
    if (agent.installArgs?.[0] === "npm") {
      log.info(
        process.platform === "win32"
          ? "A global npm install can need an elevated terminal, or npm's prefix may not be writable."
          : "A global npm install can need elevated permissions, or npm's prefix may not be writable.",
      );
    }
    log.info(`Manual route: ${installHintFor(agent)}`);
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

/**
 * Is this binary on PATH?
 *
 * This file used to answer that with its own copy of the check: spawn
 * `<bin> --version` and treat a defined exit code as proof. agentCli replaced
 * that everywhere else when Windows CI caught it — on POSIX a missing binary
 * yields ENOENT and no exit code, but on Windows the call routes through
 * cmd.exe, which returns an exit code regardless, so EVERY agent read as
 * installed.
 *
 * The copy here survived that fix, and connect is the command it breaks worst.
 * With every agent reported installed on Windows: the picker offered agents
 * that were not there, applyProvider skipped install AND login entirely, and
 * isSignedOut then probed a binary that did not exist and read the shell's
 * "not recognized" reply as an unrecognized-but-fine answer. Connect saved the
 * provider and announced "Using Cursor — via your `cursor-agent` login" without
 * a browser ever opening.
 *
 * There is one implementation now, shared with doctor/run/flow/review/compare,
 * and it walks PATH in Node rather than guessing from a subprocess.
 */
const binExists = isAgentInstalled;
