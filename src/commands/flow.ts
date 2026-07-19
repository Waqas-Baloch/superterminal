import { promises as fs } from "node:fs";
import nodePath from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { parseFlow, describeStep, type FlowStep } from "../core/flow";
import { indexRepo } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { generateManifest } from "../core/manifest";
import { loadSkills } from "../core/skills";
import { AGENT_CLIS, runAgent, isAgentInstalled, type AgentCliDef, type AgentUsage } from "../claude/agentCli";
import { snapshot, diffAgainst } from "./compare";
import { printSemanticSummary } from "./shared";
import { renderFileDiff } from "../report/diff";
import { loadConfig } from "../util/config";
import { resolveAuth } from "../util/globalConfig";
import { formatTokens } from "../util/tokens";
import { pixelWave } from "../report/spinner";
import { log } from "../util/logger";

// `glint flow` — one command, several steps, each routed to the agent you named,
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
    log.error('Couldn\'t read any steps. Try: glint flow "audit auth with claude, then fix it with cursor"');
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
      log.error(`Step "${step.task}" names no agent and none is connected. Run \`glint connect\` or name one (…with claude).`);
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
  const outDir = nodePath.join(root, ".glint", "flow", runId);
  await fs.mkdir(outDir, { recursive: true });

  const index = await indexRepo(root, config);
  const graph = await buildGraph(root, index);
  const before = await snapshot(root, index);
  const skills = await loadSkills(root);

  let carried = ""; // the previous step's output, handed to the next
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;

  for (const [i, { step, agent }] of resolved.entries()) {
    log.info("");
    log.info(pc.dim(`── step ${i + 1}/${resolved.length} · ${agent.title}${step.skill ? ` · ${step.skill}` : ""} ──`));
    log.info(step.task);

    const selection = await selectFiles({ task: step.task, root, index, graph, budget, seeds: [] });
    const manifest = await generateManifest({ root, task: step.task, selection });

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
      `Do this step now: ${step.task}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const wave = pixelWave(`${agent.title} is working…`);
    let text = "";
    let usage: AgentUsage | null = null;
    try {
      const r = await runAgent(agent, root, prompt, () => wave.stop());
      wave.stop();
      text = r.text;
      usage = r.usage;
    } catch (err) {
      wave.stop();
      log.error(err instanceof Error ? err.message : String(err));
      log.dim(`Flow stopped at step ${i + 1}. Earlier steps' changes are kept — \`glint revert\` is not aware of flows yet.`);
      process.exitCode = 1;
      return;
    }

    if (usage) {
      totalIn += usage.inputTokens;
      totalOut += usage.outputTokens;
      totalCost += usage.costUsd ?? 0;
    }
    carried = text;
    await fs.writeFile(
      nodePath.join(outDir, `step-${i + 1}.md`),
      `# Step ${i + 1} — ${agent.title}\n\n**Task:** ${step.task}\n${step.skill ? `**Skill:** ${step.skill}\n` : ""}\n${text || "(no text output)"}\n`,
    );
    log.success(`step ${i + 1} done`);
  }

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

  if (totalIn > 0 || totalOut > 0) {
    log.dim(
      `Tokens (actual, across the flow): ${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out${totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}`,
    );
  }
  log.dim(`Step outputs: ${nodePath.relative(root, outDir)}/`);
}
