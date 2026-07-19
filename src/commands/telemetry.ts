import pc from "picocolors";
import { setEnabled, status } from "../util/telemetry";
import { log } from "../util/logger";

// `glint telemetry [on|off|status]` — the off switch has to be as easy to find
// as the notice that mentions it.

export async function telemetryCommand(action?: string): Promise<void> {
  const verb = (action ?? "status").toLowerCase();

  if (verb === "off" || verb === "disable") {
    await setEnabled(false);
    log.success("Usage counting is off. Nothing will be sent.");
    return;
  }
  if (verb === "on" || verb === "enable") {
    await setEnabled(true);
    log.success("Usage counting is on — anonymous counts only, never prompts, filenames, or code.");
    return;
  }
  if (verb !== "status") {
    log.error(`Unknown option "${action}". Use: glint telemetry [on|off|status]`);
    process.exitCode = 1;
    return;
  }

  const s = await status();
  if (!s.collecting) {
    log.info("Usage counting is not configured in this build — Glint is sending nothing.");
    return;
  }
  log.info(s.enabled ? pc.green("Usage counting: on") : pc.dim("Usage counting: off"));
  log.dim(`  Anonymous id: ${s.installId}`);
  log.dim("  Sent: which agent, which command, whether it finished, version, OS.");
  log.dim("  Never sent: prompts, filenames, paths, code, diffs, repo names.");
  log.dim(s.enabled ? "  Turn off: glint telemetry off" : "  Turn on: glint telemetry on");
}
