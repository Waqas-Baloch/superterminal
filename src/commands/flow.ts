import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { parseFlow, describeStep, type FlowStep } from "../core/flow";
import { indexRepo } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { safetyGate } from "../core/gate";
import { findMissingKeeps } from "../core/understanding";
import { loadRules, extractProtectedPaths, protectedMatch } from "../core/rules";
import { generateManifest } from "../core/manifest";
import { loadSkills } from "../core/skills";
import { AGENT_CLIS, runAgent, isAgentInstalled, type AgentCliDef } from "../claude/agentCli";
import { snapshot, diffAgainst } from "./compare";
import { printSemanticSummary } from "./shared";
import { renderFileDiff } from "../report/diff";
import { loadConfig } from "../util/config";
import { resolveAuth } from "../util/globalConfig";
import { pixelWave } from "../report/spinner";
import { log } from "../util/logger";
import { track } from "../util/telemetry";
import { stateDir, statePath } from "../util/paths";

// `super-t flow` — one command, several steps, each routed to the agent you named,
// with outputs passed forward. The neutral layer's payoff: no vendor will run a
// pipeline across its rivals.

/**
 * A step named an agent that isn't installed. Ask what to do about it once,
 * and reuse the answer for every other step naming the same agent. Returns the
 * agent to run those steps with, or null to stop.
 */
async function pickSubstitute(
  wanted: AgentCliDef,
  fallback: AgentCliDef | null,
  interactive: boolean,
): Promise<AgentCliDef | null> {
  if (!interactive || !fallback || fallback.id === wanted.id) return null;
  if (!(await isAgentInstalled(fallback.bin))) return null;

  log.info("");
  log.warn(`${wanted.title} isn't installed.`);
  log.dim(`  ${wanted.installHint}`);
  const { choice } = await prompts({
    type: "select",
    name: "choice",
    message: `Run its steps with ${fallback.title} instead?`,
    choices: [
      { title: `Use ${fallback.title} for those steps`, value: "substitute" },
      { title: `Stop — I'll install ${wanted.title} first`, value: "stop" },
    ],
    initial: 0,
  });
  return choice === "substitute" ? fallback : null;
}

export async function flowCommand(input: string, opts: { budget?: string; yes?: boolean } = {}): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const budget = opts.budget ? Number(opts.budget) : config.budgetTokens;

  const steps = parseFlow(input);
  if (steps.length === 0) {
    log.error('Couldn\'t read any steps. Try: super-t flow "audit auth with claude, then fix it with cursor"');
    process.exitCode = 1;
    return;
  }

  // Default agent for steps that don't name one.
  const auth = await resolveAuth();
  const fallback: AgentCliDef | null = auth?.mode === "agent-cli" ? AGENT_CLIS[auth.agent] : null;

  const resolved: { step: FlowStep; agent: AgentCliDef; substituted?: string }[] = [];
  // A flow names agents you may not have installed. Dead-ending on the whole
  // plan is the wrong trade — offer to run those steps with the agent that IS
  // connected, so one missing CLI doesn't cost you the pipeline. Scripts
  // (--yes / no TTY) still fail loudly: silent substitution there would change
  // what ran without anyone seeing it.
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  const substitutions = new Map<string, AgentCliDef | null>(); // decided once per missing agent
  for (const step of steps) {
    const wanted = step.agent ? AGENT_CLIS[step.agent] : fallback;
    if (!wanted) {
      log.error(`Step "${step.task}" names no agent and none is connected. Run \`super-t connect\` or name one (…with claude).`);
      process.exitCode = 1;
      return;
    }
    if (await isAgentInstalled(wanted.bin)) {
      resolved.push({ step, agent: wanted });
      continue;
    }

    if (!substitutions.has(wanted.id)) {
      substitutions.set(wanted.id, await pickSubstitute(wanted, fallback, interactive));
    }
    const stand = substitutions.get(wanted.id) ?? null;
    if (!stand) {
      log.error(`${wanted.title} isn't installed (needed for "${step.task}").`);
      log.dim(`  ${wanted.installHint}`);
      await track("error", root, { code: "agent_missing", agent: wanted.id });
      process.exitCode = 1;
      return;
    }
    resolved.push({ step, agent: stand, substituted: wanted.title });
  }

  // Show the plan before anything runs — a flow is several agent runs, so the
  // confirmation is up front rather than per step.
  log.info("");
  log.info(pc.bold(`Flow — ${resolved.length} step${resolved.length === 1 ? "" : "s"}:`));
  for (const [i, r] of resolved.entries()) {
    const line = `  ${describeStep(r.step, i, r.agent.title)}`;
    // Never let a substitution pass unseen — the arrow shows the agent that
    // will really run, and the note says whose place it's taking.
    log.info(r.substituted ? `${line}  ${pc.yellow(`(standing in for ${r.substituted})`)}` : line);
  }
  log.info("");
  if (!opts.yes) {
    const { go } = await prompts({ type: "confirm", name: "go", message: "Run this flow?", initial: true });
    if (!go) {
      log.info("Cancelled — nothing ran.");
      return;
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = nodePath.join(stateDir(root), "flow", runId);
  await fs.mkdir(outDir, { recursive: true });

  const index = await indexRepo(root, config);
  const graph = await buildGraph(root, index);
  const before = await snapshot(root, index);
  const skills = await loadSkills(root);

  // One backup for the entire flow, captured incrementally as steps touch
  // files. Without this `revert` had nothing to restore after a flow — the
  // command most likely to need undoing was the one that couldn't be undone.
  const backupDir = nodePath.join(stateDir(root), "backup", runId);
  const backedUp = new Set<string>();
  const created = new Set<string>();
  await fs.mkdir(nodePath.join(backupDir, "files"), { recursive: true });
  await fs.writeFile(
    nodePath.join(backupDir, "meta.json"),
    JSON.stringify({ kind: "flow", steps: resolved.length, startedAt: new Date().toISOString() }),
  );

  /** Record pre-flow content for anything this step changed, once per file. */
  const captureOriginals = async (): Promise<void> => {
    for (const change of await diffAgainst(root, config, before)) {
      if (backedUp.has(change.path)) continue;
      backedUp.add(change.path);
      if (change.created) {
        created.add(change.path);
        continue; // nothing to restore — revert deletes it
      }
      const dest = nodePath.join(backupDir, "files", change.path);
      await fs.mkdir(nodePath.dirname(dest), { recursive: true });
      await fs.writeFile(dest, change.before);
    }
    await fs.writeFile(nodePath.join(backupDir, "created.json"), JSON.stringify([...created]));
  };

  const recordProgress = async (completed: number): Promise<void> => {
    await fs
      .writeFile(
        nodePath.join(backupDir, "meta.json"),
        JSON.stringify({ kind: "flow", steps: resolved.length, completed }),
      )
      .catch(() => {});
  };

  const protectedPaths = extractProtectedPaths((await loadRules(root)).text);
  let carried = ""; // the previous step's output, handed to the next

  for (const [i, { step, agent }] of resolved.entries()) {
    log.info("");
    log.info(pc.dim(`── step ${i + 1}/${resolved.length} · ${agent.title}${step.skill ? ` · ${step.skill}` : ""} ──`));
    log.info(step.task);

    // The same gate `run` uses — preflight, band classification, and
    // clarification — applied per step and evaluated NOW, so it sees the repo
    // as earlier steps left it rather than as it was when the flow started.
    const picked = await selectFiles({ task: step.task, root, index, graph, budget, seeds: [] });
    const gate = await safetyGate({
      task: step.task,
      root,
      index,
      graph,
      selection: picked,
      budget,
      seeds: [],
      interactive,
    });
    if (!gate.proceed) {
      log.warn(`Flow stopped at step ${i + 1} — that step wasn't safe to run unattended.`);
      if (i > 0) log.dim(`Steps 1–${i} already ran. Undo the whole flow with \`super-t revert\`.`);
      await recordProgress(i); // steps before this one did run
      await track("error", root, { code: "blocked", command: "flow", steps: i });
      process.exitCode = 1;
      return;
    }
    const selection = gate.selection;
    const manifest = await generateManifest({ root, task: gate.finalTask, selection });

    // A named skill is applied even if the matcher wouldn't have picked it —
    // you asked for it explicitly.
    const named = step.skill
      ? skills.find((s) => {
          const want = step.skill!.toLowerCase();
          return s.name.toLowerCase() === want || s.source.toLowerCase().includes(want);
        })
      : undefined;
    if (step.skill && !named) log.warn(`  Skill "${step.skill}" not found — continuing without it.`);

    const prompt = [
      manifest,
      named ? `## Skill: ${named.name}\n${named.body}` : "",
      carried ? `## Result of the previous step\n${carried}` : "",
      `Do this step now: ${gate.finalTask}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const wave = pixelWave(`${agent.title} is working…`);
    let text = "";
    try {
      const r = await runAgent(agent, root, prompt, () => wave.stop());
      wave.stop();
      text = r.text;
    } catch (err) {
      wave.stop();
      log.error(err instanceof Error ? err.message : String(err));
      await captureOriginals(); // a failed step may still have written files
      await recordProgress(i);
      log.dim(`Flow stopped at step ${i + 1}. Undo everything it changed with \`super-t revert\`.`);
      process.exitCode = 1;
      return;
    }

    await captureOriginals(); // before any check that might restore files

    // Verify what the agent actually did, same as a single run: did it edit an
    // occurrence you said to keep, and did it touch a protected path.
    if (gate.editScope) {
      const missing = await findMissingKeeps(root, gate.editScope.keep);
      if (missing.length > 0) {
        log.warn(`  Step ${i + 1} changed ${missing.length} occurrence(s) you asked to keep.`);
        log.dim("  `super-t revert` undoes the whole flow.");
      }
    }
    if (protectedPaths.length > 0) {
      const changed = await diffAgainst(root, config, before);
      const violations = changed.map((c) => c.path).filter((f) => protectedMatch(f, protectedPaths));
      if (violations.length > 0) {
        log.warn(`  Step ${i + 1} touched protected path(s): ${violations.join(", ")}`);
        log.dim("  `super-t revert` undoes the whole flow.");
      }
    }

    carried = text;
    await fs.writeFile(
      nodePath.join(outDir, `step-${i + 1}.md`),
      `# Step ${i + 1} — ${agent.title}\n\n**Task:** ${step.task}\n${step.skill ? `**Skill:** ${step.skill}\n` : ""}\n${text || "(no text output)"}\n`,
    );
    log.success(`step ${i + 1} done`);
  }

  await recordProgress(resolved.length);

  // What the whole flow changed, in one diff.
  const changes = await diffAgainst(root, config, before);
  log.info("");
  if (changes.length === 0) {
    log.info("Flow finished — no file changes.");
  } else {
    log.info(pc.bold("Changes across the flow:"));
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      const d = renderFileDiff(c.path, c.before, c.after, c.created);
      added += d.added;
      removed += d.removed;
      log.info(`  ${c.created ? pc.green("+") : pc.cyan("~")} ${c.path}  ${pc.green(`+${d.added}`)}/${pc.red(`−${d.removed}`)}`);
    }
    printSemanticSummary(new Map(changes.map((c) => [c.path, c.before])), new Map(changes.map((c) => [c.path, c.after])));
    log.info("");
    log.info(`${changes.length} file(s) changed, ${pc.green(`+${added}`)} ${pc.red(`−${removed}`)}`);
  }

  await track("flow_completed", root, {
    steps: resolved.length,
    agents: new Set(resolved.map((r) => r.agent.id)).size,
    files: changes.length,
    substituted: resolved.some((r) => r.substituted),
  });
  log.dim(`Step outputs: ${nodePath.relative(root, outDir)}/`);
}
