import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { log } from "../util/logger";

// Backup layout (written by the runner before applying edits):
//   .glint/backup/<runId>/files/<relpath>  — original content of modified files
//   .glint/backup/<runId>/created.json     — repo-relative paths of files the run created
export async function revertCommand(): Promise<void> {
  const root = process.cwd();
  const backupRoot = path.join(root, ".glint", "backup");

  let runs: string[] = [];
  try {
    runs = (await fs.readdir(backupRoot)).sort();
  } catch {
    // no backup dir
  }
  if (runs.length === 0) {
    log.info("Nothing to revert — no backups found.");
    return;
  }

  const latest = runs[runs.length - 1];
  const runDir = path.join(backupRoot, latest);
  const filesDir = path.join(runDir, "files");

  const modified = await fg("**/*", { cwd: filesDir, onlyFiles: true, dot: true }).catch(() => []);
  for (const rel of modified) {
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(filesDir, rel), dest);
  }

  let removed = 0;
  try {
    const created: string[] = JSON.parse(await fs.readFile(path.join(runDir, "created.json"), "utf8"));
    for (const rel of created) {
      await fs.rm(path.join(root, rel), { force: true });
      removed++;
    }
  } catch {
    // no created.json — nothing was created in that run
  }

  await fs.rm(runDir, { recursive: true, force: true });
  log.success(`Reverted run ${latest}: restored ${modified.length} file(s), removed ${removed} created file(s)`);
}
