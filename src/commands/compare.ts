import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { execa } from "execa";
import { indexRepo, type RepoIndex } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { generateManifest } from "../core/manifest";
import {
  AGENT_CLIS,
  runAgent,
  pathWithLocalBin,
  composeArgs,
  isLimitError,
  type AgentCliDef,
  type AgentUsage,
  type SafetyMode,
} from "../claude/agentCli";
import { recordLimit } from "../util/limits";
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

export async function compareCommand(task: string, opts: { budget?: string; parallel?: boolean; mode?: string } = {}): Promise<void> {
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

  if (opts.parallel) {
    const ready = await parallelPreflight(root);
    if (ready) {
      const results = await parallelCompare(root, agents, prompt, (opts.mode ?? config.mode) as SafetyMode);
      printComparison(results);
      await chooseAndApply(root, results);
      return;
    }
    log.warn("Parallel needs a git repo with a clean tree (commit or stash first) — running sequentially.");
  }

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

/** Parallel mode wants a clean baseline: every worktree starts from HEAD. */
async function parallelPreflight(root: string): Promise<boolean> {
  const inRepo = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, reject: false });
  if (inRepo.exitCode !== 0 || inRepo.stdout.trim() !== "true") return false;
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: root, reject: false });
  if (head.exitCode !== 0) return false;
  const dirty = await execa("git", ["status", "--porcelain"], { cwd: root, reject: false });
  return dirty.exitCode === 0 && dirty.stdout.trim() === "";
}

/**
 * Every agent at once, each in its own git worktree checked out at HEAD — full
 * isolation, so they can't clobber each other, and wall time is the slowest
 * agent instead of the sum. Live streams are suppressed (three agents
 * interleaving on one terminal is noise); one spinner tracks completion.
 */
async function parallelCompare(
  root: string,
  agents: AgentCliDef[],
  prompt: string,
  mode: SafetyMode,
): Promise<AgentResult[]> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const wtBase = nodePath.join(stateDir(root), "wt", runId);
  await fs.mkdir(wtBase, { recursive: true });

  const done: string[] = [];
  const wave = spin(`${agents.length} agents working in parallel…`).start();
  const tick = (title: string): void => {
    done.push(title);
    wave.text = `${done.length}/${agents.length} finished (${done.join(", ")})…`;
  };

  const settled = await Promise.all(
    agents.map(async (agent): Promise<AgentResult> => {
      const wt = nodePath.join(wtBase, agent.id);
      let error: string | null = null;
      let files: FileChange[] = [];
      try {
        const add = await execa("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: root, reject: false });
        if (add.exitCode !== 0) throw new Error(`worktree add failed: ${add.stderr.slice(0, 200)}`);
        // Quiet runner: capture output instead of relaying — but still
        // recognize a usage-limit refusal and record it for the cooldown ledger.
        const r = await execa(agent.bin, composeArgs(agent, agent.runArgs(prompt), false, mode), {
          cwd: wt,
          reject: false,
          timeout: 900_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PATH: pathWithLocalBin() },
        });
        if (r.exitCode !== 0) {
          const tail = `${r.stderr ?? ""}`.slice(-2000);
          if (isLimitError(tail)) {
            await recordLimit(agent.id);
            throw new Error(`${agent.title} hit its usage limit`);
          }
          throw new Error(`${agent.bin} exited with code ${r.exitCode}`);
        }
        files = await worktreeChanges(wt);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        tick(agent.title);
      }
      let added = 0;
      let removed = 0;
      for (const f of files) {
        const d = renderFileDiff(f.path, f.before, f.after, f.created);
        added += d.added;
        removed += d.removed;
      }
      // Validators are skipped in parallel mode: worktrees share git history
      // but not node_modules, so running checks there would fail for the wrong
      // reason. The chosen result can be validated after it's applied.
      return { agent, files, added, removed, validationOk: null, usage: null, error };
    }),
  );
  wave.stop();

  // Tear the worktrees down whatever happened — stale worktrees break later runs.
  for (const agent of agents) {
    await execa("git", ["worktree", "remove", "--force", nodePath.join(wtBase, agent.id)], { cwd: root, reject: false });
  }
  await execa("git", ["worktree", "prune"], { cwd: root, reject: false });
  await fs.rm(wtBase, { recursive: true, force: true }).catch(() => {});

  return settled;
}

/** What an agent changed in its worktree, as content diffs against HEAD. */
async function worktreeChanges(wt: string): Promise<FileChange[]> {
  const st = await execa("git", ["status", "--porcelain=v1"], { cwd: wt, reject: false });
  const out: FileChange[] = [];
  for (const line of st.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rel = line.slice(3).trim();
    if (!rel || code.includes("D")) continue; // deletions unsupported (same as sequential mode)
    const created = code.includes("?") || code.includes("A");
    const after = await fs.readFile(nodePath.join(wt, rel), "utf8").catch(() => null);
    if (after === null) continue; // binary or unreadable — skip rather than corrupt
    const before = created
      ? ""
      : (await execa("git", ["show", `HEAD:${rel}`], { cwd: wt, reject: false })).stdout ?? "";
    out.push({ path: rel, before, after, created });
  }
  return out;
}

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
