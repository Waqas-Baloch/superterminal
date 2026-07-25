import { getJira, type JiraCredentials } from "../util/credentials";
import type { TrackerAdapter, TrackerTicket } from "./types";

// Jira Cloud via REST v2 (still supported; returns plain-text descriptions,
// which spares us Atlassian Document Format parsing). Basic auth with the
// user's email + API token. Issue keys are strictly validated before they are
// embedded in any URL path.

const KEY_RE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

interface JiraIssue {
  key: string;
  fields?: { summary?: string; description?: string | null; labels?: string[] };
}

function toTicket(site: string, i: JiraIssue): TrackerTicket {
  return {
    id: i.key,
    ref: i.key,
    title: i.fields?.summary ?? "",
    body: typeof i.fields?.description === "string" ? i.fields.description : "",
    url: `${site}/browse/${i.key}`,
    labels: i.fields?.labels ?? [],
  };
}

async function jiraFetch<T>(cred: JiraCredentials, path: string, init?: RequestInit): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${cred.site}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${cred.email}:${cred.apiToken}`).toString("base64")}`,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Used by `tracker connect` to verify credentials before saving them. */
export async function jiraWhoAmI(cred: JiraCredentials): Promise<string | null> {
  const me = await jiraFetch<{ displayName?: string; emailAddress?: string }>(cred, "/rest/api/2/myself");
  return me?.displayName ?? me?.emailAddress ?? null;
}

export const jiraTracker: TrackerAdapter = {
  id: "jira",
  title: "Jira",
  scope: "workspace",

  async available(): Promise<true | string> {
    return (await getJira()) ? true : "not connected — run `super-t tracker connect`";
  },

  async listAssigned(): Promise<TrackerTicket[]> {
    const cred = await getJira();
    if (!cred) return [];
    const jql = encodeURIComponent("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    const d = await jiraFetch<{ issues?: JiraIssue[] }>(
      cred,
      `/rest/api/2/search?jql=${jql}&maxResults=20&fields=summary,description,labels`,
    );
    return (d?.issues ?? []).map((i) => toTicket(cred.site, i));
  },

  async listOpen(): Promise<TrackerTicket[]> {
    const cred = await getJira();
    if (!cred) return [];
    const jql = encodeURIComponent("statusCategory != Done ORDER BY updated DESC");
    const d = await jiraFetch<{ issues?: JiraIssue[] }>(
      cred,
      `/rest/api/2/search?jql=${jql}&maxResults=50&fields=summary,description,labels`,
    );
    return (d?.issues ?? []).map((i) => toTicket(cred.site, i));
  },

  async getTicket(_root: string, id: string): Promise<TrackerTicket | null> {
    const cred = await getJira();
    const clean = id.trim().toUpperCase();
    if (!cred || !KEY_RE.test(clean)) return null;
    const d = await jiraFetch<JiraIssue>(cred, `/rest/api/2/issue/${clean}?fields=summary,description,labels`);
    return d?.key ? toTicket(cred.site, d) : null;
  },

  async postComment(_root: string, id: string, body: string): Promise<boolean> {
    const cred = await getJira();
    const clean = id.trim().toUpperCase();
    if (!cred || !KEY_RE.test(clean)) return false;
    const d = await jiraFetch<{ id?: string }>(cred, `/rest/api/2/issue/${clean}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return Boolean(d?.id);
  },
};
