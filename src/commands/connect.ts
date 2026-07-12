import pc from "picocolors";
import prompts from "prompts";
import { applyProvider, detectAvailability, providerChoices } from "./provider";
import { log } from "../util/logger";

export async function connectCommand(): Promise<void> {
  log.info(pc.bold("Connect Glint to your AI — one-time setup."));
  log.info("");

  const { hasAnt, installed } = await detectAvailability();
  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "How do you want to connect?",
    choices: providerChoices({ hasAnt, installed }),
  });

  if (!provider) {
    log.info("Cancelled — nothing saved.");
    return;
  }
  if (!(await applyProvider(provider))) {
    process.exitCode = 1;
    return;
  }

  log.info("");
  log.info(`Try it: ${pc.bold('glint run "add a loading spinner to the submit button"')}`);
}
