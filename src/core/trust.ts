import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import nodePath from "node:path";
import prompts from "prompts";
import pc from "picocolors";
import { homeDir } from "../util/paths";
import { loadRules, loadContext } from "./rules";
import { loadSkills } from "./skills";
import { log } from "../util/logger";

// First-contact consent: name a repository's agent instructions before they
// are ever used to steer an agent.
//
// A repository's CLAUDE.md / AGENTS.md / rules.md / skills are injected into
// whichever agent runs, as instructions the agent is told to obey. Clone an
// unfamiliar repository, run one task, and text written by a stranger is
// steering an AI that can edit files and run commands — with nothing on screen
// to say so. Disclosure is the defence: the files are named before they are
// ever used, once per repository.
//
// Trust is recorded in ~/.super-t — NEVER inside the repo. A repository must
// not be able to ship a marker that pre-approves itself.

interface TrustFile {
  // The hash lets us tell "the rules were edited" from "the rules now contain
  // something hostile". Keying trust on the path alone missed a poisoned pull;
  // keying it on content alone would re-prompt on every legitimate edit, and a
  // prompt people see weekly is a prompt people stop reading.
  repos: Record<string, { at: string; hash?: string }>;
}

// Phrases that read as an attempt to steer the agent rather than describe the
// project. Their presence flips the prompt's default to "no" — this is the one
// place where refusing by default is worth the friction.
const SUSPICIOUS: Array<[RegExp, string]> = [
  [/ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts)/i, "tells the agent to ignore previous instructions"],
  [/\bcurl\b[^\n]{0,80}\|\s*(?:ba)?sh\b/i, "pipes a downloaded script into a shell"],
  [/\b(?:cat|read|include|print)\b[^\n]{0,40}(?:\.ssh|id_rsa|\.env|credentials|\.aws)/i, "asks the agent to read credentials"],
  [/\bbase64\s+-d\b|\becho\s+[A-Za-z0-9+/]{60,}={0,2}\s*\|/i, "hides a command in base64"],
  [/\b(?:exfiltrat|send\s+(?:the\s+)?(?:contents|secrets|keys)\s+to)\b/i, "asks the agent to send data elsewhere"],
  [/disregard\s+(?:the\s+)?(?:user|owner|safety)/i, "tells the agent to disregard the user"],
];

function file(): string {
  return nodePath.join(homeDir(), "trusted.json");
}

async function read(): Promise<TrustFile> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), "utf8"));
    return { repos: typeof raw?.repos === "object" && raw.repos ? raw.repos : {} };
  } catch {
    return { repos: {} };
  }
}

export async function isTrusted(root: string): Promise<boolean> {
  return Boolean((await read()).repos[nodePath.resolve(root)]);
}

/** A stable fingerprint of everything that will instruct the agent. */
export function instructionHash(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 32);
}

async function storedHash(root: string): Promise<string | undefined> {
  return (await read()).repos[nodePath.resolve(root)]?.hash;
}

export async function trustRepo(root: string, hash?: string): Promise<void> {
  try {
    const state = await read();
    state.repos[nodePath.resolve(root)] = { at: new Date().toISOString(), hash };
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(file(), 0o600).catch(() => {});
  } catch {
    /* failing to remember is a re-prompt, not a broken run */
  }
}

export interface InstructionSources {
  files: string[]; // repo-relative paths that will instruct the agent
  flags: string[]; // human-readable reasons this content looks like an attack
  hash: string; // fingerprint of the combined content
}

/** Which files in this repo will be injected as agent instructions, and do they look hostile? */
export async function instructionSources(root: string): Promise<InstructionSources> {
  const [rules, context, skills] = [await loadRules(root), await loadContext(root), await loadSkills(root)];
  const files = [...rules.sources, ...context.sources, ...skills.map((s) => s.source)];
  const body = [rules.text, context.text, ...skills.map((s) => s.body)].join("\n");
  const flags: string[] = [];
  for (const [re, why] of SUSPICIOUS) if (re.test(body)) flags.push(why);
  return { files: [...new Set(files)], flags, hash: instructionHash(body) };
}

/**
 * Ask once, per repository, before this repo's instructions steer an agent.
 * Returns false when the user declines — the caller must not run.
 *
 * Non-interactive runs (CI, --yes) disclose and proceed rather than block:
 * automation runs against a repository its owner already chose. The threat this
 * control addresses is a person cloning something unfamiliar.
 */
export async function ensureTrusted(root: string, interactive: boolean): Promise<boolean> {
  const { files, flags, hash } = await instructionSources(root);
  if (files.length === 0) return true; // nothing to consent to

  const already = await isTrusted(root);
  if (already) {
    const before = await storedHash(root);
    // Unchanged, or changed but still clean: stay quiet. Re-prompting on every
    // ordinary rules edit is how a security prompt becomes background noise.
    if (before === hash) return true;
    if (flags.length === 0) {
      await trustRepo(root, hash); // remember the new content, silently
      return true;
    }
    // Changed AND now looks hostile — the poisoned-pull case. Ask again.
    log.info("");
    log.warn("This repository's agent instructions changed, and the new content looks hostile:");
    for (const f of flags) log.warn(`  · it ${f}`);
    for (const f of files) log.dim(`    ${f}`);
    if (!interactive) {
      log.error("Refusing to run unattended with instructions that changed to something hostile.");
      return false;
    }
    const { keep } = await prompts({
      type: "confirm",
      name: "keep",
      message: "Trust the changed instructions?",
      initial: false,
    });
    if (!keep) {
      log.info("Not trusted — nothing was sent. Review the change (try `git diff`), then run again.");
      return false;
    }
    await trustRepo(root, hash);
    return true;
  }

  log.info("");
  log.info(pc.bold("This repository contains instructions that will be sent to your AI agent:"));
  for (const f of files) log.info(`  ${f}`);
  log.dim("  In a repository you didn't write, these can contain instructions you never approved.");

  if (flags.length > 0) {
    log.info("");
    log.warn("Some of that content looks like it is trying to steer the agent:");
    for (const f of flags) log.warn(`  · it ${f}`);
    log.dim("  Read those files before continuing.");
  }

  if (!interactive) {
    log.dim("  Proceeding (no terminal to ask in). Files listed above are being injected.");
    return true;
  }

  const { ok } = await prompts({
    type: "confirm",
    name: "ok",
    message: "Trust this repository's agent instructions?",
    // Default yes for ordinary repositories — the disclosure above is the real
    // protection, and refusing by default would train people to click through.
    // Default NO when the content itself looks like an attack.
    initial: flags.length === 0,
  });
  if (!ok) {
    log.info("Not trusted — nothing was sent. Review those files, then run again.");
    return false;
  }
  await trustRepo(root, hash);
  log.dim(`  Remembered. Managed in ${nodePath.join(homeDir(), "trusted.json")}.`);
  return true;
}
