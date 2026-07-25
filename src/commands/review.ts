import pc from "picocolors";
import { AGENT_CLIS, isAgentInstalled } from "../claude/agentCli";
import { agentFrom } from "../core/flow";
import { loadConfig, updateProjectConfig } from "../util/config";
import { loadRules } from "../core/rules";
import { loadGlobalConfig, setGlobalReviewer } from "../util/globalConfig";
import { resolveReviewer, reviewerSource } from "../core/review";
import { STATE_DIR } from "../util/paths";
import { log } from "../util/logger";

// `super-t review <agent|off|status>` — turn Second Opinion on for a project.
//
// Cross-vendor review is the product's strongest promise, and it used to
// require hand-editing a rules file to enable. Anything that important should
// be one command.

export async function reviewCommand(arg?: string, opts: { always?: boolean } = {}): Promise<void> {
  const root = process.cwd();
  const raw = (arg ?? "status").toLowerCase();
  const globalDefault = (await loadGlobalConfig())?.reviewer ?? null;

  if (raw === "status") {
    const [config, rules] = [await loadConfig(root).catch(() => null), await loadRules(root)];
    const current = config ? resolveReviewer(config, rules.text, globalDefault) : globalDefault;
    log.info("");
    if (!current) {
      log.info(pc.bold("Second opinion: off"));
      log.dim("  Acceptance criteria are found but never checked.");
      log.dim("  Turn it on here: super-t review codex   ·   everywhere: super-t review codex --always");
      return;
    }
    const source = config ? reviewerSource(config, rules.text, globalDefault) : "every project (machine default)";
    log.info(`${pc.bold("Second opinion:")} ${AGENT_CLIS[current].title} reviews every change`);
    log.dim(`  Set for: ${source}`);
    log.dim(`  If ${AGENT_CLIS[current].title} wrote the code, another installed agent reviews it instead — never itself.`);
    log.dim(`  Turn off: super-t review off${globalDefault ? " --always" : ""}`);
    return;
  }

  if (raw === "off" || raw === "none") {
    if (opts.always) {
      await setGlobalReviewer(null);
      log.success("Second opinion off by default for every project.");
      return;
    }
    const r = await updateProjectConfig(root, (c) => {
      delete c.reviewer;
    });
    if (!r.ok) return fail(r.error);
    log.success("Second opinion off for this project.");
    log.dim(`  (A "review:" line in a rules file, or a machine default, would still enable it.)`);
    return;
  }

  const id = agentFrom(raw);
  if (!id) {
    log.error(`Unknown agent "${arg}". Use: super-t review <claude|cursor|codex|off|status>`);
    process.exitCode = 1;
    return;
  }
  if (!(await isAgentInstalled(AGENT_CLIS[id].bin))) {
    log.error(`${AGENT_CLIS[id].title} isn't installed, so it can't review anything.`);
    log.dim(`  ${AGENT_CLIS[id].installHint}`);
    process.exitCode = 1;
    return;
  }
  if (opts.always) {
    if (!(await setGlobalReviewer(id))) {
      log.error("Connect an agent first: super-t connect");
      process.exitCode = 1;
      return;
    }
    log.success(`${AGENT_CLIS[id].title} will now review every change, in every project.`);
    log.dim(`  It checks each acceptance criterion read-only, and never reviews its own work —`);
    log.dim(`  if ${AGENT_CLIS[id].title} wrote the code, another installed agent reviews it instead.`);
    log.dim(`  A single project can still override this with: super-t review <agent>`);
    return;
  }
  const r = await updateProjectConfig(root, (c) => {
    c.reviewer = id;
  });
  if (!r.ok) return fail(r.error);
  log.success(`${AGENT_CLIS[id].title} will now review every change in this project.`);
  log.dim(`  It checks each acceptance criterion read-only, and never reviews its own work.`);
  log.dim(`  Saved in ${STATE_DIR}/config.json — commit it to share with your team.`);
}

function fail(error: string): void {
  log.error(error);
  process.exitCode = 1;
}
