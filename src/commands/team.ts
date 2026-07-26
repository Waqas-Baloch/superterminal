import pc from "picocolors";
import prompts from "prompts";
import { execa } from "execa";
import {
  loadTeam,
  saveTeam,
  lookupGitHubUser,
  currentGitHubUser,
  isAdmin,
  localGovernedChanges,
  behindRemote,
  writeCodeowners,
  validUsername,
  DEFAULT_GOVERNED,
  BETA_MAX_MEMBERS,
  type Team,
} from "../core/team";
import { STATE_DIR } from "../util/paths";
import { log } from "../util/logger";

// `super-t team <init|status|invite|propose>` — shared standards with admin
// approval, built on Git and GitHub rather than a service.

export async function teamCommand(action?: string, arg?: string): Promise<void> {
  const verb = (action ?? "status").toLowerCase();
  const root = process.cwd();
  if (verb === "init") return init(root);
  if (verb === "status") return status(root);
  if (verb === "invite") return invite(root, arg);
  if (verb === "propose") return propose(root, arg);
  if (verb === "remove") return remove(root, arg);
  log.error(`Unknown option "${action}". Use: super-t team <init|status|invite|remove|propose>`);
  process.exitCode = 1;
}

async function requireGitHub(root: string): Promise<string | null> {
  const me = await currentGitHubUser(root);
  if (!me) {
    log.error("Team features need GitHub — run `gh auth login` first.");
    log.dim("  Your GitHub username is how Super Terminal knows who is an admin.");
    process.exitCode = 1;
    return null;
  }
  return me;
}

async function init(root: string): Promise<void> {
  const existing = await loadTeam(root);
  if (existing) {
    log.info(`This project already has a team (${existing.admins.length} admin(s)). See \`super-t team status\`.`);
    return;
  }
  const me = await requireGitHub(root);
  if (!me) return;

  const team: Team = {
    version: 1,
    admins: [me],
    members: [me],
    governed: DEFAULT_GOVERNED,
    requireApproval: true,
  };
  await saveTeam(root, team);
  const owners = await writeCodeowners(root, team);

  log.success(`Team created — you (${me}) are the admin.`);
  log.info("");
  log.info(pc.bold("  Shared standards"));
  log.dim(`  ${STATE_DIR}/rules.md, context.md, product.md, skills/ and AGENTS.md are now team-governed.`);
  log.dim("  Commit them and every member gets the same standards on `git pull`.");
  log.info("");
  log.info(pc.bold("  Making approval real"));
  log.dim(`  Wrote ${owners}. To make admin approval enforced rather than advisory,`);
  log.dim("  protect your default branch and enable \"Require review from Code Owners\":");
  log.dim("    Settings → Branches → Add rule → Require a pull request + Require review from Code Owners");
  log.dim("  Without that, Super Terminal can only warn — GitHub is what can actually block a merge.");
  log.info("");
  log.dim(`  Beta: teams up to ${BETA_MAX_MEMBERS} members, free.`);
  log.dim("  Invite someone with their GitHub username, e.g. `super-t team invite octocat`.");
}

async function status(root: string): Promise<void> {
  const team = await loadTeam(root);
  if (!team) {
    log.info("No team in this project yet.");
    log.dim("  Create one with `super-t team init` — shared rules, admin approval, invites.");
    return;
  }
  const me = await currentGitHubUser(root);
  const admin = isAdmin(team, me);
  const changes = await localGovernedChanges(root, team);
  const behind = await behindRemote(root);

  log.info("");
  log.info(pc.bold(`Team — ${team.members.length}/${BETA_MAX_MEMBERS} member(s) (beta)`));
  log.info(`  Admins:  ${team.admins.map((a) => pc.bold(a)).join(", ")}`);
  const others = team.members.filter((m) => !team.admins.includes(m));
  if (others.length > 0) log.info(`  Members: ${others.join(", ")}`);
  log.info(`  You:     ${me ?? pc.dim("unknown (run `gh auth login`)")} ${admin ? pc.green("· admin") : pc.dim("· member")}`);

  log.info("");
  log.info(pc.bold("  Shared standards"));
  if (behind > 0) log.warn(`  ${behind} commit(s) behind the remote — run \`git pull\` so your standards are current.`);
  else log.info(`  ${pc.green("●")} up to date with the remote`);
  if (changes.length === 0) {
    log.info(`  ${pc.green("●")} no local changes to governed files`);
  } else if (admin) {
    log.info(`  ${pc.yellow("●")} you have ${changes.length} local change(s) to governed files (you're an admin — commit when ready):`);
    for (const c of changes) log.dim(`      ${c}`);
  } else {
    log.warn(`  You have ${changes.length} local change(s) to governed files, and you're not an admin:`);
    for (const c of changes) log.dim(`      ${c}`);
    log.dim("  Ask for approval with `super-t team propose \"what you changed\"` — it opens a pull request.");
  }
}

/**
 * Invite by GitHub username. Adding a repository collaborator grants real
 * access to someone else's code, so it is always confirmed explicitly and never
 * done without a terminal.
 */
async function invite(root: string, username?: string): Promise<void> {
  const team = await loadTeam(root);
  if (!team) {
    log.error("No team yet — run `super-t team init` first.");
    process.exitCode = 1;
    return;
  }
  const me = await requireGitHub(root);
  if (!me) return;
  if (!isAdmin(team, me)) {
    log.error(`Only an admin can invite members. Admins: ${team.admins.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const name = (username ?? "").trim();
  if (!validUsername(name)) {
    log.error("Usage: super-t team invite THEIR-GITHUB-USERNAME");
    log.dim("  For example: super-t team invite octocat");
    log.dim("  No angle brackets — your shell treats < and > as file redirection.");
    process.exitCode = 1;
    return;
  }
  if (team.members.some((m) => m.toLowerCase() === name.toLowerCase())) {
    log.info(`${name} is already on the team.`);
    return;
  }
  if (team.members.length >= BETA_MAX_MEMBERS) {
    log.error(`Beta teams are capped at ${BETA_MAX_MEMBERS} members.`);
    process.exitCode = 1;
    return;
  }

  // Resolve the username to an actual person FIRST. Confirming a bare string
  // is how a placeholder from the docs ended up holding write access to a real
  // repository — the name looked fine, and nobody had to look at whose it was.
  const person = await lookupGitHubUser(root, name);
  if (!person) {
    log.error(`No GitHub user called "${name}".`);
    log.dim("  Check the spelling — this is their GitHub username, not their display name or email.");
    process.exitCode = 1;
    return;
  }

  const repo = await repoSlug(root);
  log.info("");
  log.info(`  ${pc.bold(person.login)}${person.name ? ` — ${person.name}` : ""}`);
  log.dim(`  ${person.url}`);
  log.info("");
  log.warn(`This gives that person push access to ${repo ?? "this repository"}. Make sure it is who you mean.`);
  if (!process.stdin.isTTY) {
    log.error("Inviting grants access to your repository — run this in a terminal so it can be confirmed.");
    process.exitCode = 1;
    return;
  }
  const { go } = await prompts({
    type: "confirm",
    name: "go",
    message: `Invite ${person.login}${person.name ? ` (${person.name})` : ""}?`,
    initial: false,
  });
  if (!go) {
    log.info("Cancelled — no invitation sent, nothing changed.");
    return;
  }

  let granted = false;
  if (repo) {
    const r = await execa("gh", ["api", "--method", "PUT", `repos/${repo}/collaborators/${person.login}`, "-f", "permission=push"], {
      cwd: root,
      reject: false,
      timeout: 20_000,
    }).catch(() => null);
    granted = r?.exitCode === 0;
    if (!granted) log.warn(`  Couldn't grant repository access (you may not be a repo admin) — adding them to the team anyway.`);
  }

  team.members.push(person.login); // canonical casing from GitHub
  await saveTeam(root, team);
  log.success(`${person.login} added to the team${granted ? " and invited to the repository" : ""}.`);
  log.dim(`  Commit ${STATE_DIR}/team.json so the rest of the team sees them too.`);
  log.dim(`  They run: npm i -g super-t && super-t team status`);
}

/**
 * A non-admin's standards change, sent for approval as a pull request. The PR
 * is the permission request — and with CODEOWNERS plus branch protection, an
 * admin's review is what actually lets it land.
 */
async function propose(root: string, message?: string): Promise<void> {
  const team = await loadTeam(root);
  if (!team) {
    log.error("No team yet — run `super-t team init` first.");
    process.exitCode = 1;
    return;
  }
  const changes = await localGovernedChanges(root, team);
  if (changes.length === 0) {
    log.info("No local changes to governed files — nothing to propose.");
    return;
  }
  const me = await currentGitHubUser(root);
  const summary = (message ?? "").trim() || "update shared standards";

  log.info("");
  log.info(`Proposing ${changes.length} standards change(s) for admin approval:`);
  for (const c of changes) log.dim(`  ${c}`);
  if (!process.stdin.isTTY) {
    log.error("Opening a pull request is public — run this in a terminal so it can be confirmed.");
    process.exitCode = 1;
    return;
  }
  const { go } = await prompts({ type: "confirm", name: "go", message: "Commit these on a branch and open a pull request?", initial: false });
  if (!go) {
    log.info("Cancelled — nothing committed, nothing pushed.");
    return;
  }

  const branch = `standards/${me ?? "proposal"}-${Date.now().toString(36)}`;
  const run = async (args: string[]): Promise<boolean> => {
    const r = await execa("git", args, { cwd: root, reject: false, timeout: 30_000 }).catch(() => null);
    if (!r || r.exitCode !== 0) log.error(`git ${args[0]} failed: ${(r?.stderr ?? "").slice(0, 200)}`);
    return r?.exitCode === 0;
  };
  if (!(await run(["checkout", "-b", branch]))) return;
  if (!(await run(["add", "--", ...changes]))) return;
  if (!(await run(["commit", "-m", `standards: ${summary}`, "--no-verify"]))) return;
  if (!(await run(["push", "-u", "origin", branch]))) return;

  const pr = await execa(
    "gh",
    [
      "pr",
      "create",
      "--title",
      `Standards: ${summary}`.slice(0, 120),
      "--body-file",
      "-",
      "--head",
      branch,
    ],
    {
      cwd: root,
      reject: false,
      timeout: 30_000,
      input: [
        `Proposed by @${me ?? "a team member"} via \`super-t team propose\`.`,
        "",
        "Changed shared standards:",
        ...changes.map((c) => `- \`${c}\``),
        "",
        `Admins (${team.admins.map((a) => `@${a}`).join(", ")}) — this needs your approval before it applies to everyone's agents.`,
      ].join("\n"),
    },
  ).catch(() => null);

  if (pr?.exitCode === 0) {
    log.success("Pull request opened — an admin's approval will apply it to the whole team.");
    log.info(`  ${pr.stdout.trim().split("\n").pop()}`);
  } else {
    log.warn("Pushed the branch, but couldn't open the pull request automatically.");
    log.dim(`  Open it manually for branch: ${branch}`);
  }
}

/**
 * Take someone off the team, and off the repository. Mistakes must be fixable
 * inside the product: an invite that went to the wrong person previously needed
 * hand-edited JSON and a trip to GitHub's settings.
 */
async function remove(root: string, username?: string): Promise<void> {
  const team = await loadTeam(root);
  if (!team) {
    log.error("No team yet — nothing to remove from.");
    process.exitCode = 1;
    return;
  }
  const me = await requireGitHub(root);
  if (!me) return;
  if (!isAdmin(team, me)) {
    log.error(`Only an admin can remove members. Admins: ${team.admins.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const name = (username ?? "").trim();
  const match = team.members.find((m) => m.toLowerCase() === name.toLowerCase());
  if (!match) {
    log.error(`"${name || "(nobody)"}" isn't on this team.`);
    log.dim(`  Current members: ${team.members.join(", ")}`);
    log.dim("  Usage: super-t team remove THEIR-GITHUB-USERNAME");
    process.exitCode = 1;
    return;
  }
  if (team.admins.some((a) => a.toLowerCase() === match.toLowerCase()) && team.admins.length === 1) {
    log.error(`${match} is the only admin — removing them would leave nobody able to approve standards.`);
    process.exitCode = 1;
    return;
  }

  const repo = await repoSlug(root);
  log.info("");
  log.info(`This removes ${pc.bold(match)} from the team${repo ? `, and revokes their access to ${repo}` : ""}.`);
  if (process.stdin.isTTY) {
    const { go } = await prompts({ type: "confirm", name: "go", message: `Remove ${match}?`, initial: false });
    if (!go) {
      log.info("Cancelled — nothing changed.");
      return;
    }
  }

  // Revoke a pending invitation as well as accepted access — an unaccepted
  // invite still grants the moment they click it.
  if (repo) {
    const inv = await execa(
      "gh",
      ["api", `repos/${repo}/invitations`, "--jq", `.[] | select(.invitee.login=="${match}") | .id`],
      { cwd: root, reject: false, timeout: 20_000 },
    ).catch(() => null);
    const id = inv?.exitCode === 0 ? inv.stdout.trim() : "";
    if (/^\d+$/.test(id)) {
      await execa("gh", ["api", "-X", "DELETE", `repos/${repo}/invitations/${id}`], { cwd: root, reject: false, timeout: 20_000 }).catch(() => null);
      log.dim("  Pending invitation revoked.");
    }
    const collab = await execa("gh", ["api", "-X", "DELETE", `repos/${repo}/collaborators/${match}`], {
      cwd: root,
      reject: false,
      timeout: 20_000,
    }).catch(() => null);
    if (collab?.exitCode === 0) log.dim("  Repository access removed.");
  }

  team.members = team.members.filter((m) => m.toLowerCase() !== match.toLowerCase());
  team.admins = team.admins.filter((a) => a.toLowerCase() !== match.toLowerCase());
  await saveTeam(root, team);
  await writeCodeowners(root, team); // CODEOWNERS must not keep naming them
  log.success(`${match} removed from the team.`);
  log.dim(`  Commit ${STATE_DIR}/team.json and .github/CODEOWNERS so the change reaches everyone.`);
}

async function repoSlug(root: string): Promise<string | null> {
  const r = await execa("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: root,
    reject: false,
    timeout: 15_000,
  }).catch(() => null);
  const slug = r?.exitCode === 0 ? r.stdout.trim() : "";
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}
