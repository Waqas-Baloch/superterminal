import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { homeDir } from "./paths";

// Tracker credentials — protocol T3, as code.
//
// Tokens live in ONE place: ~/.super-t/credentials.json, chmod 0600. Never in
// a repo's .super-t/ (repos get committed — that is how tokens end up public),
// never in project config, never printed, never in telemetry (the enumerated
// scrubber can't carry them anyway).

export interface LinearCredentials {
  apiKey: string;
}

export interface JiraCredentials {
  site: string; // https://yourteam.atlassian.net
  email: string;
  apiToken: string;
}

interface CredentialsFile {
  linear?: LinearCredentials;
  jira?: JiraCredentials;
}

function file(): string {
  return nodePath.join(homeDir(), "credentials.json");
}

async function read(): Promise<CredentialsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), "utf8"));
    return typeof raw === "object" && raw ? (raw as CredentialsFile) : {};
  } catch {
    return {};
  }
}

async function write(c: CredentialsFile): Promise<void> {
  await fs.mkdir(homeDir(), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(file(), 0o600); // mode in writeFile doesn't apply if the file existed
}

export async function getLinear(): Promise<LinearCredentials | null> {
  return (await read()).linear ?? null;
}

export async function getJira(): Promise<JiraCredentials | null> {
  return (await read()).jira ?? null;
}

/**
 * What "0600" does and does not buy you, said plainly once.
 *
 * On macOS and Linux it means only your user account can read the file. On
 * Windows POSIX modes do not exist, so the call is a no-op and the only
 * protection is the user-profile folder's own permissions. Either way, anything
 * running AS you can read it — a malicious npm postinstall, a compromised
 * editor extension. Users of a trust product should hear that from us.
 */
export function storageWarning(): string | null {
  if (process.platform === "win32") {
    return "On Windows there are no POSIX file permissions, so this token is protected only by your user profile folder.";
  }
  return null;
}

export async function setLinear(c: LinearCredentials): Promise<void> {
  await write({ ...(await read()), linear: c });
}

export async function setJira(c: JiraCredentials): Promise<void> {
  await write({ ...(await read()), jira: c });
}

export async function clearTracker(kind: "linear" | "jira"): Promise<void> {
  const all = await read();
  delete all[kind];
  await write(all);
}

/** Which trackers have credentials — names only, never the values. */
export async function connectedTrackers(): Promise<Array<"linear" | "jira">> {
  const all = await read();
  const out: Array<"linear" | "jira"> = [];
  if (all.linear?.apiKey) out.push("linear");
  if (all.jira?.apiToken) out.push("jira");
  return out;
}

/** A Jira site must be a bare https origin — no paths, no protocol games. */
export function normalizeJiraSite(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    if (u.search || u.hash || u.username || u.password) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}
