import pc from "picocolors";
import prompts from "prompts";
import { linearWhoAmI } from "../trackers/linear";
import { jiraWhoAmI } from "../trackers/jira";
import { setLinear, setJira, clearTracker, connectedTrackers, normalizeJiraSite } from "../util/credentials";
import { log } from "../util/logger";

// `super-t tracker <connect|status|disconnect>` — paste-a-token setup for
// Linear and Jira. Tokens are validated with a real API call BEFORE saving
// (a saved-but-dead token is a support ticket), input is masked, and nothing
// secret is ever echoed back.

export async function trackerCommand(action?: string): Promise<void> {
  const verb = (action ?? "status").toLowerCase();
  if (verb === "connect") return connect();
  if (verb === "disconnect") return disconnect();
  if (verb === "status") return statusCmd();
  log.error(`Unknown option "${action}". Use: super-t tracker <connect|status|disconnect>`);
  process.exitCode = 1;
}

async function statusCmd(): Promise<void> {
  const connected = await connectedTrackers();
  log.info("");
  log.info(pc.bold("Ticket trackers"));
  log.info(`  GitHub Issues  ${pc.dim("uses your existing `gh` login — nothing to configure")}`);
  log.info(`  Linear         ${connected.includes("linear") ? pc.green("connected") : pc.dim("not connected")}`);
  log.info(`  Jira           ${connected.includes("jira") ? pc.green("connected") : pc.dim("not connected")}`);
  log.dim("  Connect with `super-t tracker connect` · tokens stay in ~/.super-t (0600), never in a repo.");
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
