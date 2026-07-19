import type { AgentCliId } from "../util/globalConfig";

// A flow is a multi-step task where each step names the agent that should run
// it and (optionally) the skill to apply — outputs pass forward:
//
//   super-t flow "audit auth with claude using the security skill,
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

// Every way people name an agent. Longest forms first — alternation is
// leftmost-first, so "claude code" and "chatgpt codex" must precede the bare
// "claude" / "codex" or they'd match only the first word.
const NAMES = "claude\\s+code|claude-code|chatgpt\\s+codex|cursor\\s+agent|claude|cursor|codex|chatgpt|gpt|openai";

/** Normalize any spelling/casing of an agent name to its id. */
export function agentFrom(name: string): AgentCliId | null {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^claude( code)?$|^claude-code$/.test(n)) return "claude-code";
  if (/^cursor( agent)?$/.test(n)) return "cursor";
  if (/^(chatgpt codex|codex|chatgpt|gpt|openai)$/.test(n)) return "codex";
  return null;
}

// How a step names its agent, most explicit first. People don't only write
// "with claude" — they write "use Claude Code to…", "ask codex to…", and
// "claude reviews…". Missing those used to route the step to whatever agent
// was connected, silently running the wrong one.
const AGENT_PATTERNS = [
  new RegExp(`\\b(?:with|in|via|using|on|by|through)\\s+(${NAMES})\\b`, "i"),
  new RegExp(`\\b(?:use|ask|have|get|let|tell)\\s+(${NAMES})\\b`, "i"),
  new RegExp(`^\\s*(${NAMES})\\b(?=\\s+(?:should|will|can|must|to\\b|\\w+s\\b))`, "i"),
  new RegExp(`^\\s*(${NAMES})\\s*[:,-]\\s*`, "i"), // "codex: fix the header"
];

// "(marketing-research.md skill)" / "using the security skill" / "with seo skill"
const SKILL_RE = /(?:\b(?:using|with)\s+)?\(?\s*(?:the\s+)?([A-Za-z0-9._-]+?)(?:\.md)?\s+skill\s*\)?/i;
const STEP_SPLIT = /\s*(?:\bthen\b|;|\n)\s*/i;

/** Arrows and numbered lists are step separators too. */
function normalize(input: string): string {
  return input
    .replace(/\s*(?:->|=>|→)\s*/g, "\n")
    .replace(/(?:^|\s)\d+[.)]\s+/g, "\n"); // "1. … 2. …" (won't touch "1.5rem")
}

export function parseFlow(input: string): FlowStep[] {
  return normalize(input)
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

  for (const re of AGENT_PATTERNS) {
    const am = task.match(re);
    if (!am) continue;
    const id = agentFrom(am[1]);
    if (!id) continue;
    agent = id;
    task = task.replace(am[0], " ");
    break;
  }

  // Deliberately no looser fallback than the patterns above: a bare mention
  // is usually the subject, not the router. "fix the cursor position" and
  // "review the gpt prompt templates" must go to the connected agent, not to
  // Cursor and Codex.

  task = task
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s.:]+$/g, "")
    .replace(/^(?:let'?s|and|also|first|next|finally|now)\s+/i, "")
    // "use claude to review" → removing "use claude" strands the "to"
    .replace(/^(?:to|and|please|:)\s+/i, "")
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
