import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import { execa } from "execa";
import { AGENT_CLIS, isAgentInstalled, pathWithLocalBin } from "../claude/agentCli";
import { resolveAuth } from "../util/globalConfig";
import { lastLimit, agoLabel } from "../util/limits";
import { status as telemetryStatus } from "../util/telemetry";
import { connectedTrackers } from "../util/credentials";
import { homeDir, stateDir, STATE_DIR } from "../util/paths";
import { loadConfig } from "../util/config";
import { loadRules } from "../core/rules";
import { resolveReviewer } from "../core/review";
import { VERSION } from "../version";
import { log } from "../util/logger";

// `super-t doctor` — one command that answers "why isn't this working" before
// it becomes a bug report. Every check prints a verdict; nothing throws.

const ok = (label: string, detail = ""): void => log.info(`  ${pc.green("●")} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`);
const warn = (label: string, detail = ""): void => log.info(`  ${pc.yellow("●")} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`);
const bad = (label: string, detail = ""): void => log.info(`  ${pc.red("●")} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`);

export async function doctorCommand(): Promise<void> {
  log.info("");
  log.info(pc.bold(`Super Terminal doctor · v${VERSION}`));
  log.info("");

  // Runtime
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}`, "requires Node 20+");

  // Connection
  const auth = await resolveAuth();
  if (!auth) bad("Not connected", "run `super-t connect`");
  else ok(`Connected via ${auth.source}`);

  // Agents: installed? version? recently limited?
  log.info("");
  log.info(pc.bold("  Agents"));
  for (const agent of Object.values(AGENT_CLIS)) {
    if (!(await isAgentInstalled(agent.bin))) {
      warn(`${agent.title} not installed`, agent.installHint);
      continue;
    }
    const v = await execa(agent.bin, ["--version"], {
      reject: false,
      timeout: 10_000,
      env: { ...process.env, PATH: pathWithLocalBin() },
    }).catch(() => null);
    const version = v?.stdout?.trim().split("\n")[0]?.slice(0, 40) ?? "installed";
    const limited = await lastLimit(agent.id);
    if (limited) warn(`${agent.title}  ${version}`, `hit its usage limit ${agoLabel(limited)}`);
    else ok(`${agent.title}  ${pc.dim(version)}`);
  }

  // Project state
  log.info("");
  log.info(pc.bold("  This project"));
  const root = process.cwd();
  const git = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, reject: false });
  if (git.exitCode === 0) ok("Git repository");
  else warn("Not a git repository", "revert still works via backups; `git init` recommended");
  const writable = await fs
    .mkdir(stateDir(root), { recursive: true })
    .then(() => true)
    .catch(() => false);
  if (writable) ok(`${STATE_DIR}/ writable`);
  else bad(`${STATE_DIR}/ not writable`, "backups and revert will fail");
  const config = await loadConfig(root).catch(() => null);
  if (config) ok(`Config loaded`, `mode: ${config.mode}${config.reviewer ? ` · reviewer: ${config.reviewer}` : ""}`);
  else bad("Config invalid", `check ${STATE_DIR}/config.json`);
  const rules = await fs
    .readFile(nodePath.join(root, STATE_DIR, "rules.md"), "utf8")
    .then(() => true)
    .catch(() => false);
  if (rules) ok("Rules file present");
  else warn("No rules file", "run `super-t init` to draft one");
  const reviewer = config ? resolveReviewer(config, (await loadRules(root)).text) : null;
  if (reviewer) ok("Second opinion on", `${AGENT_CLIS[reviewer].title} reviews every change`);
  else warn("Second opinion off", "acceptance criteria won't be checked — `super-t review codex`");

  // Trackers (names only — tokens are never displayed)
  const trackers = await connectedTrackers();
  log.info("");
  log.info(pc.bold("  Ticket trackers"));
  ok("GitHub Issues", "via `gh` login");
  if (trackers.includes("linear")) ok("Linear connected");
  else warn("Linear not connected", "super-t tracker connect");
  if (trackers.includes("jira")) ok("Jira connected");
  else warn("Jira not connected", "super-t tracker connect");

  // Home + telemetry
  log.info("");
  log.info(pc.bold("  Machine"));
  ok(`State home  ${pc.dim(homeDir())}`);
  const t = await telemetryStatus();
  if (!t.collecting) ok("Usage counting not configured in this build");
  else if (t.enabled) ok("Usage counting on", "anonymous counts only · `super-t telemetry off`");
  else ok("Usage counting off");
  log.info("");
}
