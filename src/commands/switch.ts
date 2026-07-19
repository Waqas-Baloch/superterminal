import pc from "picocolors";
import prompts from "prompts";
import { applyProvider, detectAvailability, providerChoices, providerLabel } from "./provider";
import { loadGlobalConfig } from "../util/globalConfig";
import { connectCommand } from "./connect";
import { log } from "../util/logger";

export async function switchCommand(): Promise<void> {
  const current = (await loadGlobalConfig())?.provider;
  if (!current) {
    log.info("Not connected yet — let's set you up first.");
    log.info("");
    return connectCommand();
  }

  log.info(pc.bold("Switch coding agent") + pc.dim(`  — currently: ${providerLabel(current)}`));
  log.info("");

  const { hasAnt, installed } = await detectAvailability();
  const choices = providerChoices({ hasAnt, installed, current });
  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "Switch to:",
    choices,
    initial: Math.max(0, choices.findIndex((c) => c.value === current)),
  });

  if (!provider) {
    log.info(`Cancelled — still using ${providerLabel(current)}.`);
    return;
  }
  if (provider === current) {
    log.info(`Already using ${providerLabel(current)} — no change.`);
    return;
  }
  if (!(await applyProvider(provider))) {
    process.exitCode = 1;
    return;
  }
  log.dim("Your next `super-t run` uses this agent.");
}
