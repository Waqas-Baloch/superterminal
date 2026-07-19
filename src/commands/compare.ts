import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { execa } from "execa";
import { indexRepo, type RepoIndex } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { generateManifest } from "../core/manifest";
import { AGENT_CLIS, runAgent, pathWithLocalBin, type AgentCliDef, type AgentUsage } from "../claude/agentCli";
import { runValidators } from "../validate/validator";
import { loadConfig, type ProjectConfig } from "../util/config";
import { renderFileDiff } from "../report/diff";
import { spin } from "../report/spinner";
import { log } from "../util/logger";
import { stateDir } from "../util/paths";

// Cross-agent A/B — the one thing no agent vendor can ever ship: run the SAME
// task through two (or more) agents on identical context, show the results side
// by side, and let you keep the best one. Agents run sequentially, each on a
// clean slate (we revert between them), so they never clobber each other.

export interface FileChange {
  path: string;
  before: string;
  after: string;
  created: boolean;
}

interface AgentResult {
  agent: AgentCliDef;
  files: FileChange[];
  added: number;
  removed: number;
  validationOk: boolean | null; // null = no validators configured
  usage: AgentUsage | null;
  error: string | null;
}

export async function compareCommand(task: string, opts: { budget?: string } = {}): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const budget = opts.budget ? Number(opts.budget) : config.budgetTokens;

  const agents: AgentCliDef[] = [];
  for (const a of Object.values(AGENT_CLIS)) if (await isInstalled(a.bin)) agents.push(a);
  if (agents.length < 2) {
    log.warn("Compare needs at least two agent CLIs installed (Claude Code, Cursor, ChatGPT/Codex).");
    log.dim(`Found: ${agents.map((a) => a.title).join(", ") || "none"}. Add another with \`super-t connect\`.`);
    process.exitCode = 1;
    return;
  }

  log.info("");
  log.info(`Comparing ${agents.map((a) => pc.bold(a.title)).join(" vs ")} on the same task.`);

  // Build the manifest once — identical context for every agent, so the only
  // variable is the agent itself.
  const sp = spin("Selecting context…").start();
  const index = await indexRepo(root, config);
  const graph = await buildGraph(root, index);
  const selection = await selectFiles({ task, root, index, graph, budget, seeds: [] });
  const manifest = await generateManifest({ root, task, selection });
  sp.stop();
  const prompt = `${manifest}\n\nImplement the task now, exactly as described under "How to apply this task" — smallest change that literally satisfies it, nothing extra.`;

  const before = await snapshot(root, index);
  const results: AgentResult[] = [];
  for (const agent of agents) {
    log.info("");
    log.info(pc.dim(`── ${agent.title} ──`));
    const wave = spin(`${agent.title} is working…`).start();
    let usage: AgentUsage | null = null;
    let error: string | null = null;
    try {
      usage = (await runAgent(agent, root, prompt, () => wave.stop())).usage;
      wave.stop();
    } catch (e) {
      wave.stop();
      error = e instanceof Error ? e.message : String(e);
    }
    const validation = await runValidators(root).catch(() => [] as { ok: boolean }[]);
    const validationOk = validation.length === 0 ? null : validation.every((r) => r.ok);
    const files = await diffAgainst(root, config, before);
    let added = 0;
    let removed = 0;
    for (const f of files) {
      const d = renderFileDiff(f.path, f.before, f.after, f.created);
      added += d.added;
      removed += d.removed;
    }
    results.push({ agent, files, added, removed, validationOk, usage, error });
    await restoreTo(root, before, files); // clean slate for the next agent
  }

  printComparison(results);
  await chooseAndApply(root, results);
}

function printComparison(results: AgentResult[]): void {
  log.info("");
  log.info(pc.bold("Comparison — same task, same context:"));
  for (const r of results) {
    const status = r.error
      ? pc.red("errored")
      : r.validationOk === false
        ? pc.red("checks FAILED")
        : r.validationOk
          ? pc.green("checks passed")
          : pc.dim("no checks");
    log.info(
      `  ${pc.bold(r.agent.title.padEnd(16))} ${String(r.files.length).padStart(2)} file(s)  ${pc.green(`+${r.added}`)}/${pc.red(`−${r.removed}`)}  ${status}`,
    );
    if (r.error) log.dim(`      ${r.error}`);
  }
}

async function chooseAndApply(root: string, results: AgentResult[]): Promise<void> {
  const usable = results.filter((r) => !r.error && r.files.length > 0);
  if (usable.length === 0) {
    log.info("");
    log.info("No agent produced changes to keep — repo unchanged.");
    return;
  }
  const choices = results.map((r, i) => ({
    title: `${r.agent.title} — ${r.files.length} file(s), +${r.added}/−${r.removed}${
      r.validationOk === false ? " · checks FAILED" : r.validationOk ? " · checks passed" : ""
    }`,
    value: String(i),
    disabled: r.error !== null || r.files.length === 0,
  }));
  choices.push({ title: "Keep none — leave the repo unchanged", value: "none", disabled: false });

  const ans = await prompts({ type: "select", name: "pick", message: "Which result do you want to keep?", choices });
  if (ans.pick === undefined || ans.pick === "none") {
    log.info("Kept none — repo unchanged.");
    return;
  }
  const chosen = results[Number(ans.pick)];
  await backupThenApply(root, chosen.files);
  log.success(`Applied ${chosen.agent.title}'s changes — ${chosen.files.length} file(s).`);
  log.dim("Undo anytime with `super-t revert`.");
}

// ── file-state helpers (exported for tests) ──────────────────────────────────

export async function snapshot(root: string, index: RepoIndex): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  for (const f of index.files) map.set(f.path, await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => null));
  return map;
}

/** What changed vs the snapshot: modified + newly-created files, with content. */
export async function diffAgainst(
  root: string,
  config: ProjectConfig,
  before: Map<string, string | null>,
): Promise<FileChange[]> {
  const nowIndex = await indexRepo(root, config);
  const out: FileChange[] = [];
  for (const f of nowIndex.files) {
    const after = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => "");
    const prior = before.get(f.path);
    if (prior === undefined || prior === null) {
      if (after.trim()) out.push({ path: f.path, before: "", after, created: true });
    } else if (prior !== after) {
      out.push({ path: f.path, before: prior, after, created: false });
    }
  }
  return out;
}

/** Undo a set of changes: restore modified files, delete created ones. */
export async function restoreTo(root: string, before: Map<string, string | null>, files: FileChange[]): Promise<void> {
  for (const f of files) {
    const abs = nodePath.join(root, f.path);
    if (f.created) await fs.rm(abs, { force: true });
    else await fs.writeFile(abs, before.get(f.path) ?? f.before);
  }
}

/** Write a backup (so `super-t revert` works) then apply the chosen agent's changes. */
async function backupThenApply(root: string, files: FileChange[]): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const filesDir = nodePath.join(stateDir(root), "backup", runId, "files");
  const created: string[] = [];
  for (const f of files) {
    if (f.created) {
      created.push(f.path);
    } else {
      const dest = nodePath.join(filesDir, f.path);
      await fs.mkdir(nodePath.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.before);
    }
  }
  await fs.mkdir(nodePath.join(stateDir(root), "backup", runId), { recursive: true });
  await fs.writeFile(nodePath.join(stateDir(root), "backup", runId, "created.json"), JSON.stringify(created));

  for (const f of files) {
    const abs = nodePath.join(root, f.path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.after);
  }
}

async function isInstalled(bin: string): Promise<boolean> {
  const r = await execa("which", [bin], {
    reject: false,
    env: { ...process.env, PATH: pathWithLocalBin() },
  }).catch(() => null);
  return r !== null && r.exitCode === 0;
}
