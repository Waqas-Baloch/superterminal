import pc from "picocolors";
import prompts from "prompts";
import { linearWhoAmI } from "../trackers/linear";
import { jiraWhoAmI } from "../trackers/jira";
import { setLinear, setJira, clearTracker, connectedTrackers, normalizeJiraSite, storageWarning } from "../util/credentials";
import { loadConfig, updateProjectConfig } from "../util/config";
import { STATE_DIR } from "../util/paths";
import { log } from "../util/logger";

// `super-t tracker <connect|status|disconnect>` — paste-a-token setup for
// Linear and Jira. Tokens are validated with a real API call BEFORE saving
// (a saved-but-dead token is a support ticket), input is masked, and nothing
// secret is ever echoed back.

export async function trackerCommand(action?: string, which?: string): Promise<void> {
  const verb = (action ?? "status").toLowerCase();
  if (verb === "connect") return connect();
  if (verb === "disconnect") return disconnect();
  if (verb === "use") return use(which);
  if (verb === "status") return statusCmd();
  log.error(`Unknown option "${action}". Use: super-t tracker <connect|use|status|disconnect>`);
  process.exitCode = 1;
}

/**
 * Pin which tracker this project uses. Without a pin, the first usable one
 * wins — and GitHub qualifies from ambient state (a remote + a gh login),
 * which quietly beat a tracker the user had deliberately connected.
 */
async function use(which?: string): Promise<void> {
  const name = (which ?? "").toLowerCase();
  const valid = ["github", "linear", "jira", "auto"];
  if (!valid.includes(name)) {
    log.error(`Usage: super-t tracker use <github|linear|jira|auto>`);
    log.dim("  auto = clear the pin and use the first usable tracker again.");
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const r = await updateProjectConfig(root, (c) => {
    if (name === "auto") delete c.tracker;
    else c.tracker = name;
  });
  if (!r.ok) {
    log.error(r.error);
    process.exitCode = 1;
    return;
  }
  if (name === "auto") log.success(`Tracker pin removed — this project will use the first usable tracker again.`);
  else log.success(`This project now uses ${name === "github" ? "GitHub Issues" : name === "linear" ? "Linear" : "Jira"} for \`super-t ticket\`.`);
  log.dim(`  Saved in ${STATE_DIR}/config.json — commit it to share the choice with your team.`);
}

async function statusCmd(): Promise<void> {
  const connected = await connectedTrackers();
  log.info("");
  log.info(pc.bold("Ticket trackers"));
  log.info(`  GitHub Issues  ${pc.dim("uses your existing `gh` login — nothing to configure")}`);
  log.info(`  Linear         ${connected.includes("linear") ? pc.green("connected") : pc.dim("not connected")}`);
  log.info(`  Jira           ${connected.includes("jira") ? pc.green("connected") : pc.dim("not connected")}`);
  const pinned = await loadConfig(process.cwd())
    .then((c) => c.tracker)
    .catch(() => undefined);
  log.info("");
  log.info(pinned ? `  This project is pinned to: ${pc.bold(pinned)}` : pc.dim("  This project: no pin — the first usable tracker wins"));
  log.dim("  Pin one with `super-t tracker use linear` · connect with `super-t tracker connect`.");
  log.dim("  Tokens stay in ~/.super-t (0600), never in a repo.");
}

async function connect(): Promise<void> {
  const { which } = await prompts({
    type: "select",
    name: "which",
    message: "Which tracker?",
    choices: [
      { title: "Linear — personal API key", value: "linear" },
      { title: "Jira Cloud — email + API token", value: "jira" },
      { title: "GitHub Issues — already handled by `gh` login", value: "github" },
    ],
  });
  if (which === undefined) return;
  if (which === "github") {
    log.info("Nothing to set up — `super-t ticket` uses your existing `gh auth login` session.");
    return;
  }

  if (which === "linear") {
    log.dim("  Create one at linear.app → Settings → Security & access → Personal API keys.");
    const { key } = await prompts({ type: "password", name: "key", message: "Linear API key" });
    if (!key?.trim()) return;
    const who = await linearWhoAmI(key.trim());
    if (!who) {
      log.error("Linear rejected that key — nothing was saved.");
      process.exitCode = 1;
      return;
    }
    await setLinear({ apiKey: key.trim() });
    log.success(`Connected to Linear as ${who}. Try: super-t ticket`);
    noteStorage();
    return;
  }

  // Jira
  log.dim("  Create a token at id.atlassian.com → Security → API tokens.");
  const answers = await prompts([
    { type: "text", name: "site", message: "Jira site (e.g. yourteam.atlassian.net)" },
    { type: "text", name: "email", message: "Atlassian account email" },
    { type: "password", name: "token", message: "API token" },
  ]);
  const site = normalizeJiraSite(answers.site ?? "");
  if (!site) {
    log.error("That site isn't a plain https origin — expected something like https://yourteam.atlassian.net");
    process.exitCode = 1;
    return;
  }
  if (!answers.email?.trim() || !answers.token?.trim()) return;
  const cred = { site, email: answers.email.trim(), apiToken: answers.token.trim() };
  const who = await jiraWhoAmI(cred);
  if (!who) {
    log.error("Jira rejected those credentials — nothing was saved.");
    process.exitCode = 1;
    return;
  }
  await setJira(cred);
  log.success(`Connected to Jira (${site}) as ${who}. Try: super-t ticket`);
  noteStorage();
}

async function disconnect(): Promise<void> {
  const connected = await connectedTrackers();
  if (connected.length === 0) {
    log.info("No tracker tokens stored.");
    return;
  }
  const { which } = await prompts({
    type: "select",
    name: "which",
    message: "Disconnect which tracker?",
    choices: connected.map((c) => ({ title: c === "linear" ? "Linear" : "Jira", value: c })),
  });
  if (which === undefined) return;
  await clearTracker(which);
  log.success(`${which === "linear" ? "Linear" : "Jira"} token removed from this machine.`);
}

/** Say where the token lives, and what that protection is actually worth. */
function noteStorage(): void {
  log.dim("  Stored in ~/.super-t/credentials.json (owner-only), never in a repository.");
  const w = storageWarning();
  if (w) log.warn(`  ${w}`);
}
