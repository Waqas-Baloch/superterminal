import { execa } from "execa";
import type { TrackerAdapter, TrackerTicket } from "./types";

// GitHub Issues via the `gh` CLI. gh brings its own auth (browser login the
// user already did) — Super Terminal never sees or stores a GitHub token.
// Every call is an argv array (no shell), and the comment body travels via
// stdin so ticket-sized text never touches a command line.

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  url: string;
  labels?: Array<{ name?: string }>;
}

function toTicket(i: GhIssue): TrackerTicket {
  return {
    id: String(i.number),
    ref: `#${i.number}`,
    title: i.title ?? "",
    body: i.body ?? "",
    url: i.url ?? "",
    labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
  };
}

// Availability probes get a short leash: a tracker that can't answer "are you
// usable?" quickly is not usable, and 30s of silence reads as a hang. Real
// queries keep the longer budget.
const PROBE_TIMEOUT = 8_000;
const QUERY_TIMEOUT = 30_000;

async function gh(
  root: string,
  args: string[],
  opts: { input?: string; timeout?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await execa("gh", args, {
    cwd: root,
    reject: false,
    timeout: opts.timeout ?? QUERY_TIMEOUT,
    input: opts.input,
    // gh must never sit waiting on input during a probe.
    stdin: opts.input === undefined ? "ignore" : "pipe",
  });
  return { ok: r.exitCode === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const githubTracker: TrackerAdapter = {
  id: "github",
  title: "GitHub Issues",
  scope: "repository", // gh issue list is scoped to the repo you're standing in

  async available(root: string): Promise<true | string> {
    // All three probes at once, then interpreted in priority order so the
    // message stays as specific as the sequential version was.
    const probe = { timeout: PROBE_TIMEOUT };
    const [version, auth, repo] = await Promise.all([
      gh(root, ["--version"], probe).catch(() => null),
      gh(root, ["auth", "status"], probe).catch(() => null),
      gh(root, ["repo", "view", "--json", "name"], probe).catch(() => null),
    ]);
    if (!version?.ok) return "the `gh` CLI isn't installed (https://cli.github.com)";
    if (!auth?.ok) return "gh isn't signed in — run `gh auth login`";
    if (!repo?.ok) return "this folder isn't a GitHub repository (no GitHub remote)";
    return true;
  },

  async listAssigned(root: string): Promise<TrackerTicket[]> {
    const r = await gh(root, [
      "issue", "list",
      "--assignee", "@me",
      "--state", "open",
      "--limit", "20",
      "--json", "number,title,body,url,labels",
    ]);
    if (!r.ok) return [];
    try {
      return (JSON.parse(r.stdout) as GhIssue[]).map(toTicket);
    } catch {
      return [];
    }
  },

  async listOpen(root: string): Promise<TrackerTicket[]> {
    const r = await gh(root, ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url,labels"]);
    if (!r.ok) return [];
    try {
      return (JSON.parse(r.stdout) as GhIssue[]).map(toTicket);
    } catch {
      return [];
    }
  },

  async getTicket(root: string, id: string): Promise<TrackerTicket | null> {
    const clean = id.replace(/^#/, "").trim();
    if (!/^\d{1,8}$/.test(clean)) return null; // issue ids are numbers; nothing else reaches argv
    const r = await gh(root, ["issue", "view", clean, "--json", "number,title,body,url,labels"]);
    if (!r.ok) return null;
    try {
      return toTicket(JSON.parse(r.stdout) as GhIssue);
    } catch {
      return null;
    }
  },

  async postComment(root: string, id: string, body: string): Promise<boolean> {
    const clean = id.replace(/^#/, "").trim();
    if (!/^\d{1,8}$/.test(clean)) return false;
    const r = await gh(root, ["issue", "comment", clean, "--body-file", "-"], { input: body });
    return r.ok;
  },
};
