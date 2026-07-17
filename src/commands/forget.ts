import { forgetAll } from "../core/memory";
import { log } from "../util/logger";

/** Wipe the repo's learned disambiguation choices (.glint/intent.json). */
export async function forgetCommand(): Promise<void> {
  const n = await forgetAll(process.cwd());
  if (n === 0) {
    log.info("No remembered choices to forget.");
    return;
  }
  log.success(`Forgot ${n} remembered choice${n === 1 ? "" : "s"}. Glint will ask again next time.`);
}
