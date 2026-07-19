import { promises as fs } from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { glintHome } from "./globalConfig";
import { VERSION } from "../version";

// Anonymous usage counts, so we can see whether people get Glint working —
// installs, setup completion, tasks finished, and whether they come back.
//
// The hard rule, enforced structurally below: nothing a person typed and
// nothing read from disk ever leaves the machine. No prompts, no filenames,
// no paths, no code, no diffs, no repo names. Only the fixed field names in
// ALLOWED, carrying primitives, and only values Glint itself chose.
//
// PostHog project key. Public by design: it can only write events in, never
// read anything out, which is why it ships inside the package. (The secret
// counterpart is a personal key, phx_ — that one must never appear here.)
const BUILT_IN_KEY = "phc_tD3DNhmLnyV5MuhxRXLWVGzAcizSc5Jgav2FoqUZHFCK";

// Read at call time, not import time: an env override has to work, and a test
// that sets one has to actually exercise the network path.
const projectKey = (): string => process.env.GLINT_TELEMETRY_KEY ?? BUILT_IN_KEY;
const host = (): string => process.env.GLINT_TELEMETRY_HOST ?? "https://eu.i.posthog.com"; // EU project
const TIMEOUT_MS = 800; // never make someone wait on analytics

export type TelemetryEvent =
  | "installed"
  | "connected"
  | "task_completed"
  | "flow_completed"
  | "error";

/**
 * Every field that may be transmitted, and the exact values it may hold.
 *
 * String fields are ENUMERATED, not pattern-matched. That distinction is the
 * whole guarantee: a filename like "landing-page.md" satisfies any reasonable
 * "safe characters" pattern, because filenames are made of safe characters.
 * Only a fixed list of Glint's own vocabulary can express "this cannot be user
 * data". Anything unrecognized becomes "other" — never a truncated original.
 */
const FIELDS: Record<string, "number" | "boolean" | "version" | readonly string[]> = {
  agent: ["claude-code", "cursor", "codex", "api", "api-key", "oauth"],
  command: ["run", "flow", "compare", "plan"],
  outcome: ["applied", "reverted", "cancelled", "failed"],
  band: ["green", "yellow", "orange", "red"],
  code: ["no_auth", "agent_missing", "agent_error", "parse_failed", "timeout", "no_steps"],
  os: ["darwin", "linux", "win32", "freebsd", "openbsd", "aix", "sunos"],
  steps: "number",
  agents: "number",
  files: "number",
  node: "number",
  substituted: "boolean",
  version: "version",
};

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export type Props = Record<string, string | number | boolean | undefined>;

/**
 * Strip a props object down to what's allowed to leave. Exported so the
 * privacy guarantee is directly testable rather than merely asserted.
 */
export function scrub(props: Props): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    const rule = FIELDS[key];
    if (!rule || value === undefined) continue;

    if (rule === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n)) out[key] = Math.round(n);
      continue;
    }
    if (rule === "boolean") {
      if (typeof value === "boolean") out[key] = value;
      continue;
    }
    if (rule === "version") {
      if (typeof value === "string" && VERSION_RE.test(value)) out[key] = value;
      continue;
    }
    // Enumerated: in the list, or "other". No third outcome.
    out[key] = typeof value === "string" && rule.includes(value) ? value : "other";
  }
  return out;
}

interface Ids {
  installId: string;
  enabled: boolean;
  notified: boolean;
  installSent?: boolean;
  repos: Record<string, string>; // sha256(abs path) → random id; the hash never leaves
}

function stateFile(): string {
  return nodePath.join(glintHome(), "telemetry.json");
}

async function readState(): Promise<Ids> {
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8"));
    if (typeof raw.installId === "string") {
      return {
        installId: raw.installId,
        enabled: raw.enabled !== false,
        notified: raw.notified === true,
        installSent: raw.installSent === true, // dropping this re-sent "installed" every run
        repos: typeof raw.repos === "object" && raw.repos ? raw.repos : {},
      };
    }
  } catch {
    /* no state yet — fall through and create it */
  }
  // Mint the id ONCE and persist it immediately. If this only lived in memory,
  // every command would report a fresh id and every run would look like a new
  // user — which would make the activation numbers worse than having none.
  const fresh: Ids = { installId: crypto.randomUUID(), enabled: true, notified: false, repos: {} };
  await writeState(fresh);
  return fresh;
}

async function writeState(s: Ids): Promise<void> {
  try {
    await fs.mkdir(glintHome(), { recursive: true });
    await fs.writeFile(stateFile(), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* never let bookkeeping break a command */
  }
}

/** Off via env var, or via `glint telemetry off`. */
export async function isEnabled(): Promise<boolean> {
  const env = process.env.GLINT_TELEMETRY;
  if (env === "0" || env?.toLowerCase() === "off" || env?.toLowerCase() === "false") return false;
  if (process.env.DO_NOT_TRACK === "1") return false; // consoledonottrack.com
  if (process.env.CI) return false; // CI installs aren't users
  return (await readState()).enabled;
}

export async function setEnabled(on: boolean): Promise<void> {
  await writeState({ ...(await readState()), enabled: on });
}

export async function status(): Promise<{ enabled: boolean; installId: string; collecting: boolean }> {
  const s = await readState();
  return { enabled: await isEnabled(), installId: s.installId, collecting: Boolean(projectKey()) };
}

/**
 * A stable random id for a repo, so we can count active projects without ever
 * learning what or where they are. The path is hashed only to key the local
 * lookup — the hash stays on disk; only the random id is ever sent.
 */
async function repoId(root: string): Promise<string> {
  const key = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const s = await readState();
  if (!s.repos[key]) {
    s.repos[key] = crypto.randomUUID();
    await writeState(s);
  }
  return s.repos[key];
}

/**
 * Fire `installed` exactly once per machine. This is the denominator of the
 * activation funnel — without it you can measure how many people connected
 * but not what share of arrivals that represents, which is the number that
 * says whether setup is the problem.
 */
export async function trackInstallOnce(): Promise<void> {
  try {
    if (!projectKey() || !(await isEnabled())) return;
    const s = await readState();
    if (s.installSent) return;
    // Persist ONLY after delivery. Marking first meant a fast-exiting command
    // (`glint --version`, `glint --help`) could kill the request in flight and
    // still record it as sent — silently losing the funnel's denominator with
    // no retry. Offline first runs now simply try again next time.
    if (await track("installed", null)) await writeState({ ...s, installSent: true });
  } catch {
    /* never block startup */
  }
}

/**
 * The one-time notice. Returns the text to print, or null if it's already
 * been shown. Kept here so the wording lives next to what it describes.
 */
export async function firstRunNotice(): Promise<string | null> {
  if (!projectKey()) return null;
  if (!(await isEnabled())) return null;
  const s = await readState();
  if (s.notified) return null;
  await writeState({ ...s, notified: true });
  return "Super Terminal counts anonymous usage (which agent, whether a task finished) to see what's working.\nNever your prompts, filenames, or code. Turn it off: glint telemetry off";
}

/**
 * Record an event. Fire-and-forget: bounded by a short timeout, never throws,
 * never blocks a command, and silently does nothing when unconfigured.
 */
export async function track(event: TelemetryEvent, root: string | null, props: Props = {}): Promise<boolean> {
  try {
    const key = projectKey();
    if (!key) return false;
    if (!(await isEnabled())) return false;
    const s = await readState();

    const payload = {
      api_key: key,
      event,
      distinct_id: s.installId,
      properties: {
        ...scrub({
          ...props,
          version: VERSION, // npm_package_version is unset for a real CLI install
          os: process.platform,
          node: process.versions.node.split(".")[0],
        }),
        ...(root ? { repo: await repoId(root) } : {}),
        $process_person_profile: false,
      },
      timestamp: new Date().toISOString(),
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    await fetch(`${host()}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch {
    /* analytics must never surface to the user or fail a command */
    return false;
  }
}
