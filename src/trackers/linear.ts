import { getLinear } from "../util/credentials";
import type { TrackerAdapter, TrackerTicket } from "./types";

// Linear via its GraphQL API with a personal API key. Narrowest use: read
// issues assigned to you, create comments. Queries use GraphQL VARIABLES —
// ticket ids and bodies never get string-built into a query.

const API = "https://api.linear.app/graphql";
const ID_RE = /^[A-Za-z0-9]+-\d{1,7}$/; // "ENG-142" — validated before any API use

interface LinearIssue {
  id: string; // uuid — what mutations want
  identifier: string; // "ENG-142" — what humans see
  title: string;
  description?: string | null;
  url: string;
}

function toTicket(i: LinearIssue): TrackerTicket {
  return { id: i.id, ref: i.identifier, title: i.title ?? "", body: i.description ?? "", url: i.url ?? "", labels: [] };
}

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    return json.errors?.length ? null : (json.data ?? null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Used by `tracker connect` to verify a key before saving it. */
export async function linearWhoAmI(apiKey: string): Promise<string | null> {
  const d = await gql<{ viewer?: { displayName?: string; email?: string } }>(apiKey, "query { viewer { displayName email } }", {});
  return d?.viewer?.displayName ?? d?.viewer?.email ?? null;
}

const OPEN_STATES = '{ type: { nin: ["completed", "canceled"] } }';
const FIELDS = "nodes { id identifier title description url }";

export const linearTracker: TrackerAdapter = {
  id: "linear",
  title: "Linear",
  scope: "workspace", // Linear assignment is workspace-wide, not per-repo

  async available(): Promise<true | string> {
    return (await getLinear()) ? true : "not connected — run `super-t tracker connect`";
  },

  async listAssigned(): Promise<TrackerTicket[]> {
    const cred = await getLinear();
    if (!cred) return [];
    const d = await gql<{ issues?: { nodes?: LinearIssue[] } }>(
      cred.apiKey,
      `query Assigned($first: Int!) {
        issues(first: $first, orderBy: updatedAt,
               filter: { assignee: { isMe: { eq: true } }, state: ${OPEN_STATES} }) { ${FIELDS} }
      }`,
      { first: 50 },
    );
    return (d?.issues?.nodes ?? []).map(toTicket);
  },

  async listOpen(): Promise<TrackerTicket[]> {
    const cred = await getLinear();
    if (!cred) return [];
    const d = await gql<{ issues?: { nodes?: LinearIssue[] } }>(
      cred.apiKey,
      `query Open($first: Int!) {
        issues(first: $first, orderBy: updatedAt, filter: { state: ${OPEN_STATES} }) { ${FIELDS} }
      }`,
      { first: 50 },
    );
    return (d?.issues?.nodes ?? []).map(toTicket);
  },

  async getTicket(_root: string, id: string): Promise<TrackerTicket | null> {
    const cred = await getLinear();
    const clean = id.trim().toUpperCase();
    if (!cred || !ID_RE.test(clean)) return null;
    const d = await gql<{ issue?: LinearIssue }>(
      cred.apiKey,
      "query One($id: String!) { issue(id: $id) { id identifier title description url } }",
      { id: clean },
    );
    return d?.issue ? toTicket(d.issue) : null;
  },

  async postComment(_root: string, id: string, body: string): Promise<boolean> {
    const cred = await getLinear();
    if (!cred) return false;
    const d = await gql<{ commentCreate?: { success?: boolean } }>(
      cred.apiKey,
      "mutation Post($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      { issueId: id, body },
    );
    return d?.commentCreate?.success === true;
  },
};
