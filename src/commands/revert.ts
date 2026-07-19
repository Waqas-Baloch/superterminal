import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { log } from "../util/logger";
import { existingStateDirs } from "../util/paths";

// Backup layout (written by the runner before applying edits):
//   <state>/backup/<runId>/files/<relpath>  — original content of modified files
//   <state>/backup/<runId>/created.json     — repo-relative paths of files the run created
export async function revertCommand(): Promise<void> {
  const root = process.cwd();

  // Look in every state directory, current and legacy. A run backed up before
  // the rename must still be revertible — reporting "nothing to revert" while
  // the backup sits on disk is the worst possible rename side effect.
  const runs: { id: string; dir: string }[] = [];
  for (const stateRoot of await existingStateDirs(root)) {
    const backupRoot = path.join(stateRoot, "backup");
    for (const id of await fs.readdir(backupRoot).catch(() => [])) {
      runs.push({ id, dir: path.join(backupRoot, id) });
    }
  }
  if (runs.length === 0) {
    log.info("Nothing to revert — no backups found.");
    return;
  }

  // Run ids are ISO timestamps, so lexical order is chronological.
  runs.sort((a, b) => a.id.localeCompare(b.id));
  const { id: latest, dir: runDir } = runs[runs.length - 1];
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
