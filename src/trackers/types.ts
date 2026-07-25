// Tracker adapters — the neutral bridge between ticket systems and agents.
// One interface; GitHub ships first (rides `gh`'s existing auth — no token for
// us to store), Linear/Jira follow as paste-a-token adapters.

export interface TrackerTicket {
  id: string; // "142" — what the adapter's API wants
  ref: string; // "#142" — what humans see
  title: string;
  body: string; // UNTRUSTED: anyone who can file a ticket authored this
  url: string;
  labels: string[];
}

export interface TrackerAdapter {
  id: "github" | "linear" | "jira";
  title: string;
  /** Where "assigned to you" looks: GitHub is per-repo, Linear/Jira are workspace-wide. */
  scope: "repository" | "workspace";
  /** true when usable in this repo; otherwise a human-readable reason. */
  available(root: string): Promise<true | string>;
  /** Open tickets assigned to the authenticated user. */
  listAssigned(root: string): Promise<TrackerTicket[]>;
  getTicket(root: string, id: string): Promise<TrackerTicket | null>;
  /** Open tickets regardless of assignee — used to explain an empty "assigned to me". */
  listOpen?(root: string): Promise<TrackerTicket[]>;
  /** Post a comment. Callers MUST have user confirmation first (protocol T2). */
  postComment(root: string, id: string, body: string): Promise<boolean>;
}
