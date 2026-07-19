import pc from "picocolors";
import prompts from "prompts";
import { applyProvider, detectAvailability, providerChoices } from "./provider";
import { log } from "../util/logger";
import { track, firstRunNotice } from "../util/telemetry";

export async function connectCommand(): Promise<void> {
  log.info(pc.bold("Connect Glint to your AI — one-time setup."));
  // Setup is the natural place for the notice — before anything is recorded.
  const notice = await firstRunNotice();
  if (notice) for (const line of notice.split("\n")) log.dim(line);
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

  // The single most important funnel step: installed → actually connected.
  await track("connected", null, { agent: String(provider) });

  log.info("");
  log.info(`Try it: ${pc.bold('glint run "add a loading spinner to the submit button"')}`);
}
