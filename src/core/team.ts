import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { statePath, stateDir, STATE_DIR, ensureStateDir } from "../util/paths";

// The team layer. Git and GitHub ARE the backend: the standards registry is
// files in the repo, "sync to every member" is `git pull`, and "ask permission
// to edit" is a pull request. That is stronger than a service we could run,
// because GitHub's branch protection genuinely blocks an unauthorized merge
// while any check inside a CLI can be edited out of a fork.
//
// Be precise about what this file provides:
//   • a guardrail — it catches accidents and makes intent explicit
//   • NOT a security boundary — anyone with repo write access can edit
//     team.json itself. Real enforcement is CODEOWNERS + branch protection,
//     which `team init` generates and links.

export const BETA_MAX_MEMBERS = 5; // beta: teams up to five, free

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/; // GitHub's own rule

/** Is this a syntactically valid GitHub username? Checked before it reaches argv. */
export function validUsername(name: string): boolean {
  return USERNAME_RE.test(name.trim());
}

const teamSchema = z.object({
  version: z.literal(1),
  admins: z.array(z.string()).min(1), // GitHub usernames who may change standards
  members: z.array(z.string()).default([]),
  /** Repo-relative paths whose edits need admin approval. */
  governed: z.array(z.string()).default([]),
  requireApproval: z.boolean().default(true),
});

export type Team = z.infer<typeof teamSchema>;

/** The standards a team shares. Everything an agent is told to obey. */
export const DEFAULT_GOVERNED = [
  `${STATE_DIR}/rules.md`,
  `${STATE_DIR}/context.md`,
  `${STATE_DIR}/product.md`,
  `${STATE_DIR}/skills`,
  `${STATE_DIR}/config.json`,
  "AGENTS.md",
  "CLAUDE.md",
];

export function teamFile(root: string): string {
  return statePath(root, "team.json");
}

export async function loadTeam(root: string): Promise<Team | null> {
  try {
    // Repo content, so it is parsed and validated — never trusted blindly, and
    // nothing in it is ever executed.
    return teamSchema.parse(JSON.parse(await fs.readFile(teamFile(root), "utf8")));
  } catch {
    return null;
  }
}

export async function saveTeam(root: string, team: Team): Promise<void> {
  await ensureStateDir(root);
  await fs.writeFile(teamFile(root), JSON.stringify(team, null, 2) + "\n");
}

/** The GitHub login of whoever is running this, straight from gh's own auth. */
export async function currentGitHubUser(root: string): Promise<string | null> {
  const r = await execa("gh", ["api", "user", "--jq", ".login"], { cwd: root, reject: false, timeout: 15_000 }).catch(
    () => null,
  );
  const login = r?.exitCode === 0 ? r.stdout.trim() : "";
  return login && validUsername(login) ? login : null;
}

export interface GitHubPerson {
  login: string;
  name: string | null;
  url: string;
}

/**
 * Look up who a username actually belongs to, before anything is granted.
 *
 * A username that merely LOOKS valid is not good enough: `a-teammate` — the
 * placeholder from our own docs — is a real account belonging to a real
 * stranger, and inviting it granted them write access to a private repo. A
 * one-character typo can likewise land on somebody else's account. So we resolve
 * the name and show the human behind it before asking for confirmation.
 */
export async function lookupGitHubUser(root: string, name: string): Promise<GitHubPerson | null> {
  if (!validUsername(name)) return null;
  const r = await execa("gh", ["api", `users/${name}`, "--jq", "[.login, .name, .html_url] | @tsv"], {
    cwd: root,
    reject: false,
    timeout: 15_000,
  }).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  const [login, personName, url] = r.stdout.trim().split("\t");
  return login ? { login, name: personName || null, url: url || `https://github.com/${login}` } : null;
}

export function isAdmin(team: Team, user: string | null): boolean {
  return Boolean(user) && team.admins.some((a) => a.toLowerCase() === user!.toLowerCase());
}

/**
 * Governed files this working copy has changed but not committed — i.e. someone
 * editing shared standards locally. Modified and untracked both count: a new
 * skill file is as much a standards change as an edited rule.
 */
export async function localGovernedChanges(root: string, team: Team): Promise<string[]> {
  const paths = team.governed.length > 0 ? team.governed : DEFAULT_GOVERNED;
  const r = await execa("git", ["status", "--porcelain", "--", ...paths], {
    cwd: root,
    reject: false,
    timeout: 15_000,
  }).catch(() => null);
  if (!r || r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ""));
}

/** Does the repo have commits the local copy hasn't pulled? Standards may be stale. */
export async function behindRemote(root: string): Promise<number> {
  const r = await execa("git", ["rev-list", "--count", "HEAD..@{upstream}"], {
    cwd: root,
    reject: false,
    timeout: 15_000,
  }).catch(() => null);
  const n = r?.exitCode === 0 ? Number(r.stdout.trim()) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * CODEOWNERS content that makes admin approval real rather than advisory.
 * The CLI guardrail can be bypassed; a protected branch requiring a CODEOWNERS
 * review cannot.
 */
export function codeownersFor(team: Team): string {
  const owners = team.admins.map((a) => `@${a}`).join(" ");
  const lines = [
    "# Super Terminal: shared standards need an admin review.",
    "# Enforced by GitHub when the default branch is protected with",
    "# \"Require review from Code Owners\" enabled.",
    ...(team.governed.length > 0 ? team.governed : DEFAULT_GOVERNED).map((p) => `${p.startsWith("/") ? p : `/${p}`} ${owners}`),
  ];
  return lines.join("\n") + "\n";
}

export async function writeCodeowners(root: string, team: Team): Promise<string> {
  const dir = nodePath.join(root, ".github");
  await fs.mkdir(dir, { recursive: true });
  const file = nodePath.join(dir, "CODEOWNERS");
  await fs.writeFile(file, codeownersFor(team));
  return ".github/CODEOWNERS";
}

/**
 * Warn when the standards about to be sent to an agent aren't the team's.
 *
 * This is the case that actually matters: a member edits rules.md locally and
 * every agent then obeys THEIR version, not the team's, with nothing on screen
 * to say so. Returns the lines to print, or null when all is well.
 */
export async function standardsWarning(root: string): Promise<string[] | null> {
  const team = await loadTeam(root);
  if (!team || !team.requireApproval) return null;
  const me = await currentGitHubUser(root);
  if (isAdmin(team, me)) return null; // admins are allowed to change standards
  const changes = await localGovernedChanges(root, team);
  if (changes.length === 0) return null;
  return [
    `Using ${changes.length} uncommitted change(s) to team standards — not approved by an admin:`,
    ...changes.map((c) => `    ${c}`),
    `Agents in this run will follow your local version. Send it for approval: super-t team propose "what changed"`,
  ];
}
