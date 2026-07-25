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

async function gh(root: string, args: string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await execa("gh", args, { cwd: root, reject: false, timeout: 30_000, input });
  return { ok: r.exitCode === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const githubTracker: TrackerAdapter = {
  id: "github",
  title: "GitHub Issues",

  async available(root: string): Promise<true | string> {
    const version = await gh(root, ["--version"]).catch(() => null);
    if (!version?.ok) return "the `gh` CLI isn't installed (https://cli.github.com)";
    const auth = await gh(root, ["auth", "status"]);
    if (!auth.ok) return "gh isn't signed in — run `gh auth login`";
    const repo = await gh(root, ["repo", "view", "--json", "name"]);
    if (!repo.ok) return "this folder isn't a GitHub repository (no GitHub remote)";
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
    const r = await gh(root, ["issue", "comment", clean, "--body-file", "-"], body);
    return r.ok;
  },
};
