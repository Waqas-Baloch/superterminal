import pc from "picocolors";
import prompts from "prompts";
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { usableTrackers } from "../trackers";
import type { TrackerAdapter, TrackerTicket } from "../trackers/types";
import { ticketCriteria } from "../trackers/ticketText";
import { stateDir } from "../util/paths";
import { runCommand } from "./run";
import { loadConfig } from "../util/config";
import { spin } from "../report/spinner";
import { redactSecrets } from "../report/runReport";
import { log } from "../util/logger";

// `super-t ticket [id]` — the PM loop, end to end: pick a ticket assigned to
// you from EVERY connected tracker, implement it through the full safety stack,
// have a different vendor check each acceptance criterion, then (only with your
// confirmation) post the PM-readable summary back on the ticket.

/** A ticket plus the tracker it came from — needed to comment back on it. */
interface SourcedTicket {
  adapter: TrackerAdapter;
  ticket: TrackerTicket;
}

export async function ticketCommand(idArg: string | undefined, opts: { mode?: string; with?: string } = {}): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root).catch(() => null);
  const { usable, reasons } = await usableTrackers(root, config?.tracker);
  if (usable.length === 0) {
    log.error("No ticket tracker is usable here:");
    for (const r of reasons) log.dim(`  · ${r}`);
    log.dim("  Connect one with `super-t tracker connect`.");
    return;
  }

  const found = idArg ? await findById(root, usable, idArg) : await pickTicket(root, usable);
  if (!found) {
    if (idArg) log.error(`Couldn't find ticket "${idArg}" in ${usable.map((a) => a.title).join(", ")}.`);
    return;
  }
  const { adapter, ticket } = found;

  const criteria = ticketCriteria(ticket);
  log.info("");
  log.info(`${pc.bold(ticket.ref)} — ${ticket.title}`);
  log.dim(
    `  ${adapter.title} · ${criteria.length} acceptance criteri${criteria.length === 1 ? "on" : "a"} found${criteria.length === 0 ? " (reviewer will judge against the description)" : ""}`,
  );

  // The ticket rides through the normal run path: same gate, same bands, same
  // verification. The body is fenced as data inside the manifest — the task
  // string is derived from the title only (protocol T2).
  await runCommand(undefined, { mode: opts.mode, ticket });

  await offerPostBack(root, adapter, ticket);
}

/** An explicit id, looked up across every usable tracker at once. */
async function findById(root: string, adapters: TrackerAdapter[], id: string): Promise<SourcedTicket | null> {
  const sp = adapters.length > 1 ? spin(`Looking for ${id} in ${adapters.length} trackers…`).start() : null;
  const results = await Promise.all(
    adapters.map(async (adapter) => ({ adapter, ticket: await adapter.getTicket(root, id).catch(() => null) })),
  );
  sp?.stop();
  const matches = results.filter((r): r is SourcedTicket => r.ticket !== null);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Linear and Jira both use KEY-123 keys, so the same id can exist in both.
  // Guessing would implement the wrong ticket, so ask.
  log.info(`"${id}" exists in more than one tracker.`);
  if (!process.stdin.isTTY) {
    for (const m of matches) log.info(`  ${m.adapter.title}: ${m.ticket.title.slice(0, 60)}`);
    log.error("Ambiguous id and no terminal to choose in — pin one tracker: super-t tracker use <name>");
    return null;
  }
  const { pick } = await prompts({
    type: "select",
    name: "pick",
    message: "Which one did you mean?",
    choices: matches.map((m, i) => ({ title: `${m.adapter.title} — ${m.ticket.title.slice(0, 60)}`, value: String(i) })),
  });
  return pick === undefined ? null : matches[Number(pick)];
}

/** Everything assigned to you, from every usable tracker, in one list. */
async function pickTicket(root: string, adapters: TrackerAdapter[]): Promise<SourcedTicket | null> {
  const sp = spin(`Loading tickets from ${adapters.map((a) => a.title).join(", ")}…`).start();
  const [assigned, failures] = await gather(root, adapters, (a) => a.listAssigned(root));
  sp.stop();
  // A tracker's error text is echoed to the screen, so it goes through the same
  // redaction as reports — an SDK that ever embeds a token in a message must
  // not put it on someone's terminal.
  for (const f of failures) log.dim(`  (${redactSecrets(f)})`);

  let tickets = assigned;
  let showingUnassigned = false;

  // An empty list has two very different causes — nothing exists, or things
  // exist but aren't assigned to you. Saying which one saves a support round
  // trip (and "0 results" looked identical to a broken query before this).
  if (tickets.length === 0) {
    const sp2 = spin("Nothing assigned to you — checking for open tickets…").start();
    const [open] = await gather(root, adapters, (a) => (a.listOpen ? a.listOpen(root) : Promise.resolve([])));
    sp2.stop();
    if (open.length === 0) {
      log.info(`No open tickets in ${adapters.map((a) => a.title).join(" or ")}.`);
      return null;
    }
    log.info(`No tickets are assigned to you, but ${open.length} open ticket(s) exist across ${adapters.length > 1 ? "your trackers" : adapters[0].title}.`);
    if (!process.stdin.isTTY) return null;
    const { show } = await prompts({
      type: "confirm",
      name: "show",
      message: `Pick from all ${open.length} open ticket(s) instead?`,
      initial: true,
    });
    if (!show) {
      log.dim(`  Assign one to yourself, then run this again.`);
      return null;
    }
    tickets = open;
    showingUnassigned = true;
  }

  if (!showingUnassigned) {
    const bySource = adapters
      .map((a) => ({ title: a.title, n: tickets.filter((t) => t.adapter.id === a.id).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} from ${x.title}`);
    log.info(`${tickets.length} ticket(s) assigned to you — ${bySource.join(", ")}.`);
  }

  // No terminal means no choosing. Print the list and name the id to pass —
  // prompts() would otherwise wait on input that can never arrive, which hung
  // `super-t ticket` forever in scripts and CI.
  if (!process.stdin.isTTY) {
    log.info("Pick one by id (no terminal to choose in):");
    for (const t of tickets) log.info(`  ${t.ticket.ref}  ${pc.dim(`[${t.adapter.title}]`)} ${t.ticket.title.slice(0, 60)}`);
    log.dim(`  e.g. super-t ticket ${tickets[0].ticket.ref}`);
    return null;
  }

  const { pick } = await prompts({
    type: "select",
    name: "pick",
    message: "Which ticket?",
    // The source is part of the label: with several trackers merged, "SUP-6"
    // alone doesn't say where it lives or where a comment would land.
    choices: tickets.map((t, i) => ({
      title: `${pc.dim(`[${t.adapter.title}]`)} ${t.ticket.ref}  ${t.ticket.title.slice(0, 60)}`,
      value: String(i),
    })),
  });
  return pick === undefined ? null : tickets[Number(pick)];
}

/**
 * Run one query against every tracker concurrently, keeping each ticket paired
 * with its source. One tracker being down must never hide the others' work, so
 * failures are collected and reported rather than thrown.
 */
async function gather(
  root: string,
  adapters: TrackerAdapter[],
  query: (a: TrackerAdapter) => Promise<TrackerTicket[]>,
): Promise<[SourcedTicket[], string[]]> {
  const settled = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return { adapter, tickets: await query(adapter), error: null as string | null };
      } catch (e) {
        return { adapter, tickets: [] as TrackerTicket[], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const out: SourcedTicket[] = [];
  const failures: string[] = [];
  for (const r of settled) {
    if (r.error) failures.push(`${r.adapter.title} didn't respond: ${r.error.slice(0, 80)}`);
    for (const ticket of r.tickets) out.push({ adapter: r.adapter, ticket });
  }
  return [out, failures];
}

/**
 * Post the latest run report to the ticket — with explicit confirmation, every
 * time. Non-interactive runs never post (a CI job silently commenting on
 * tickets is exactly the kind of surprise this product exists to prevent).
 */
export async function offerPostBack(root: string, adapter: TrackerAdapter, ticket: TrackerTicket): Promise<void> {
  const report = await latestReport(root);
  if (!report) return;
  if (!process.stdin.isTTY) {
    log.dim(`Report ready at ${nodePath.relative(root, report.path)} — post it manually (non-interactive runs never post).`);
    return;
  }

  log.info("");
  const preview = report.body.split("\n").slice(0, 12).join("\n");
  log.dim(preview.length < report.body.length ? `${preview}\n  …` : preview);
  const { post } = await prompts({
    type: "confirm",
    name: "post",
    message: `Post this summary to ${ticket.ref} on ${adapter.title}?`,
    initial: false,
  });
  if (!post) {
    log.info(`Not posted. The report stays at ${nodePath.relative(root, report.path)}.`);
    return;
  }
  const footer = `\n\n---\n_Implemented and cross-vendor-verified via [Super Terminal](https://github.com/Waqas-Baloch/superterminal)._`;
  const ok = await adapter.postComment(root, ticket.id, report.body + footer);
  if (ok) log.success(`Posted to ${ticket.ref}.`);
  else log.error(`Posting to ${ticket.ref} failed — the report is still at ${nodePath.relative(root, report.path)}.`);
}

async function latestReport(root: string): Promise<{ path: string; body: string } | null> {
  try {
    const dir = nodePath.join(stateDir(root), "reports");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) return null;
    const path = nodePath.join(dir, files[files.length - 1]);
    return { path, body: await fs.readFile(path, "utf8") };
  } catch {
    return null;
  }
}
