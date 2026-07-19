import prompts from "prompts";
import { assessTask, runQuestions, compileTask, type EditScope } from "./clarify";
import { isModifyAction, targetDescriptors, findMissingTargets } from "./preflight";
import { rememberChoice } from "./memory";
import type { Instance } from "./understanding";
import { selectFiles, type Selection, type SeedFile } from "./selector";
import type { RepoIndex } from "./indexer";
import type { RepoGraph } from "./mapper";
import { spin } from "../report/spinner";
import { printBand } from "../commands/shared";
import { log } from "../util/logger";

// The safety gate that runs before any agent is invoked: does the target
// exist, how risky is this, and does it need a question first.
//
// This lives here rather than inside `run` because `flow` needs exactly the
// same protection. It used to be inline, which meant a flow step went straight
// to an agent with no band classification, no clarification, and no preflight —
// the multi-step command, doing several edits unattended, was the one with the
// least supervision.

export interface GateResult {
  proceed: boolean;
  finalTask: string; // task plus any clarifications the answers produced
  selection: Selection; // re-targeted when answers changed what to send
  editScope: EditScope | null; // occurrences authorized to change / keep
}

export interface GateInput {
  task: string;
  root: string;
  index: RepoIndex;
  graph: RepoGraph;
  selection: Selection;
  budget: number;
  seeds: SeedFile[];
  /** False for --yes, non-TTY, or --no-ask: questions can't be asked, so risky work stops instead. */
  interactive: boolean;
  /** Prefix for log lines, so flow steps can indent under their heading. */
  label?: string;
}

export async function safetyGate(input: GateInput): Promise<GateResult> {
  const { task, root, index, graph, budget, seeds, interactive } = input;
  let selection = input.selection;
  const stop = (): GateResult => ({ proceed: false, finalTask: task, selection, editScope: null });

  const assessment = await assessTask(task, selection, root);

  // Preflight: a modify/destructive edit needs an existing target. If every
  // specific thing the task names is absent from the whole repo, don't spend
  // tokens letting the agent rediscover that.
  if (isModifyAction(assessment.frame.action)) {
    const named = targetDescriptors(task);
    const missing = named.length > 0 ? await findMissingTargets(root, index.files, named) : [];
    if (missing && named.length > 0 && missing.length === named.length) {
      log.info("");
      log.warn(`Couldn't find ${missing.map((m) => `“${m}”`).join(" or ")} anywhere in the codebase.`);
      log.dim(
        `A ${assessment.frame.action} needs an existing target — sending this would just spend tokens for the agent to find the same. Check the name, or that you're in the right project.`,
      );
      if (!interactive) return stop();
      const ans = await prompts({ type: "confirm", name: "send", message: "Send to the agent anyway?", initial: false });
      if (!ans.send) {
        log.info("Cancelled — no tokens spent.");
        return stop();
      }
    }
  }

  printBand(assessment.band, assessment.reason);

  // Red: a destructive edit collides with identical targets in several places.
  // Never auto-apply it blind — if we can't ask, stop with the evidence
  // instead of changing every occurrence.
  if (assessment.band === "red" && !interactive) {
    log.warn(`Blocked: ${assessment.reason}.`);
    log.dim("Name the exact target or section in your task, or re-run interactively (without --yes) to choose.");
    return stop();
  }

  if (assessment.recallNote) log.dim(`  ↳ ${assessment.recallNote}`);
  const asked =
    interactive && assessment.questions.length > 0
      ? await runQuestions(assessment.questions)
      : { refinements: [], scope: null as EditScope | null, cancelled: false };
  if (asked.cancelled) {
    log.info("");
    log.info("Cancelled — nothing was changed.");
    return stop();
  }
  if (asked.scope) await rememberChoice(root, scopeToChoice(asked.scope));

  const answered = [...assessment.autoRefinements, ...asked.refinements];
  const editScope = asked.scope ?? assessment.autoScope;
  const refinements = assessment.styleNote ? [...answered, assessment.styleNote] : answered;
  const finalTask = refinements.length > 0 ? compileTask(task, refinements) : task;

  if (answered.length > 0) {
    const reSpin = spin("Re-targeting with clarified task…").start();
    selection = await selectFiles({ task: finalTask, root, index, graph, budget, seeds });
    reSpin.stop();
  }

  return { proceed: true, finalTask, selection, editScope };
}

/** EditScope holds Instances; repo memory stores their landmark/value ids. */
export function scopeToChoice(scope: EditScope): { phrase: string; change: string[]; keep: string[] } {
  const idOf = (i: Instance): string => i.landmark || i.value;
  return { phrase: scope.phrase, change: scope.change.map(idOf), keep: scope.keep.map(idOf) };
}
