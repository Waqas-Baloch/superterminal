import type { AgentCliId } from "../util/globalConfig";

// A flow is a multi-step task where each step names the agent that should run
// it and (optionally) the skill to apply — outputs pass forward:
//
//   glint flow "audit auth with claude using the security skill,
//               then implement the fixes with cursor,
//               then review the diff with codex"
//
// Parsing is deterministic on purpose: no LLM planning round-trip, so the plan
// is predictable, free, testable, and shown to you before anything runs.

export interface FlowStep {
  task: string;
  agent: AgentCliId | null; // null → use whichever agent is currently connected
  skill: string | null; // skill name to apply to this step
}

const AGENT_ALIASES: [RegExp, AgentCliId][] = [
  [/^claude(\s+code)?$|^claude-code$/i, "claude-code"],
  [/^cursor$/i, "cursor"],
  [/^(codex|chatgpt|gpt|openai)$/i, "codex"],
];

const STEP_SPLIT = /\s*(?:\bthen\b|;|\n)\s*/i;
// "(marketing-research.md skill)" / "using the security skill" / "with seo skill"
const SKILL_RE = /(?:\b(?:using|with)\s+)?\(?\s*(?:the\s+)?([A-Za-z0-9._-]+?)(?:\.md)?\s+skill\s*\)?/i;
const AGENT_RE = /\b(?:with|in|via|using|on)\s+(claude\s+code|claude-code|claude|cursor|codex|chatgpt|gpt|openai)\b/i;

export function parseFlow(input: string): FlowStep[] {
  return input
    .split(STEP_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseStep)
    .filter((s) => s.task.length > 0);
}

function parseStep(raw: string): FlowStep {
  let task = raw;
  let skill: string | null = null;
  let agent: AgentCliId | null = null;

  const sm = task.match(SKILL_RE);
  if (sm) {
    skill = sm[1];
    task = task.replace(sm[0], " ");
  }

  const am = task.match(AGENT_RE);
  if (am) {
    const name = am[1].trim();
    for (const [re, id] of AGENT_ALIASES) {
      if (re.test(name)) {
        agent = id;
        break;
      }
    }
    if (agent) task = task.replace(am[0], " ");
  }

  task = task
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s.]+$/g, "")
    .replace(/^(?:let'?s|and|also|first|next|finally|now)\s+/i, "")
    .replace(/\s+and$/i, "") // "…with claude and then…" leaves a dangling "and"
    .trim();
  return { task, agent, skill };
}

/**
 * One-line summary of a step, for the plan preview. `runningAgent` is the agent
 * that will ACTUALLY run it — which is not always the one the step named, since
 * a missing CLI can be substituted. The preview must show what will happen, not
 * what was asked for.
 */
export function describeStep(s: FlowStep, index: number, runningAgent: string): string {
  const bits = [`${index + 1}. ${s.task}`, `→ ${runningAgent}`];
  if (s.skill) bits.push(`· skill: ${s.skill}`);
  return bits.join("  ");
}
