import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { stateDir, findStateFile } from "../util/paths";

// Repo memory: Glint learns your disambiguation answers so it stops asking the
// same question. When you say "the nav one" for a duplicate "Try Now", that
// choice is saved to <state>/intent.json and auto-applied next time — the CLI
// gets calibrated to *your* repo and asks less every week.

const STORE = "intent.json";
const MAX_CHOICES = 200;

export interface IntentChoice {
  phrase: string; // normalized (lowercased) target copy the user chose about
  change: string[]; // landmark/id of the occurrence(s) to change
  keep: string[]; // landmark/id of the occurrence(s) to leave alone
  updatedAt: string;
}

interface Store {
  version: 1;
  choices: IntentChoice[];
}

/** Where new choices are written. */
function file(root: string): string {
  return nodePath.join(stateDir(root), STORE);
}

/** Where existing choices live — the current store, or an earlier brand's. */
async function existingFile(root: string): Promise<string> {
  return (await findStateFile(root, STORE)) ?? file(root);
}

export async function loadIntents(root: string): Promise<IntentChoice[]> {
  try {
    const raw = JSON.parse(await fs.readFile(await existingFile(root), "utf8")) as Store;
    return Array.isArray(raw.choices) ? raw.choices : [];
  } catch {
    return []; // no memory yet, or unreadable — start fresh
  }
}

export function recall(intents: IntentChoice[], phrase: string): IntentChoice | undefined {
  const key = phrase.trim().toLowerCase();
  return intents.find((c) => c.phrase === key);
}

export async function rememberChoice(root: string, choice: Omit<IntentChoice, "updatedAt">): Promise<void> {
  const phrase = choice.phrase.trim().toLowerCase();
  if (!phrase || choice.change.length === 0) return;
  const intents = (await loadIntents(root)).filter((c) => c.phrase !== phrase); // replace any prior answer
  intents.unshift({ ...choice, phrase, updatedAt: new Date().toISOString() });
  const store: Store = { version: 1, choices: intents.slice(0, MAX_CHOICES) };
  await fs.mkdir(nodePath.dirname(file(root)), { recursive: true });
  await fs.writeFile(file(root), JSON.stringify(store, null, 2));
}

/** Wipe all learned choices. Returns how many were forgotten. */
export async function forgetAll(root: string): Promise<number> {
  const n = (await loadIntents(root)).length;
  await fs.rm(file(root), force());
  return n;
}

function force(): { force: true } {
  return { force: true };
}
