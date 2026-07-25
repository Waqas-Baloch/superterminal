import pc from "picocolors";
import prompts from "prompts";
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { resolveTracker } from "../trackers";
import type { TrackerAdapter, TrackerTicket } from "../trackers/types";
import { ticketCriteria } from "../trackers/ticketText";
import { stateDir } from "../util/paths";
import { runCommand } from "./run";
import { loadConfig } from "../util/config";
import { log } from "../util/logger";

// `super-t ticket [id]` — the PM loop, end to end: pick a ticket assigned to
// you, implement it through the full safety stack, have a different vendor
// check each acceptance criterion, then (only with your confirmation) post the
// PM-readable summary back on the ticket.

export async function ticketCommand(idArg: string | undefined, opts: { mode?: string; with?: string } = {}): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root).catch(() => null);
  const resolved = await resolveTracker(root, config?.tracker);
  if ("reasons" in resolved) {
    log.error("No ticket tracker is usable here:");
    for (const r of resolved.reasons) log.dim(`  · ${r}`);
    return;
  }
  const { adapter } = resolved;

  const ticket = idArg ? await adapter.getTicket(root, idArg) : await pickTicket(root, adapter);
  if (!ticket) {
    if (idArg) log.error(`Couldn't load ticket "${idArg}" from ${adapter.title}.`);
    return;
  }

  const criteria = ticketCriteria(ticket);
  log.info("");
  log.info(`${pc.bold(ticket.ref)} — ${ticket.title}`);
  log.dim(`  ${adapter.title} · ${criteria.length} acceptance criteri${criteria.length === 1 ? "on" : "a"} found${criteria.length === 0 ? " (reviewer will judge against the description)" : ""}`);

  // The ticket rides through the normal run path: same gate, same bands, same
  // verification. The body is fenced as data inside the manifest — the task
  // string is derived from the title only (protocol T2).
  await runCommand(undefined, { mode: opts.mode, ticket });

  await offerPostBack(root, adapter, ticket);
}

async function pickTicket(root: string, adapter: TrackerAdapter): Promise<TrackerTicket | null> {
  const where = adapter.scope === "repository" ? "in this repository" : "in your workspace";
  let tickets = await adapter.listAssigned(root);

  // An empty list has two very different causes — nothing exists, or things
  // exist but aren't assigned to you. Saying which one saves a support round
  // trip (and "0 results" looked identical to a broken query before this).
  if (tickets.length === 0) {
    const open = (await adapter.listOpen?.(root)) ?? [];
    if (open.length === 0) {
      log.info(`No open ${adapter.title} tickets ${where}.`);
      return null;
    }
    log.info(`No ${adapter.title} tickets are assigned to you, but ${open.length} open ticket(s) exist ${where}.`);
    if (!process.stdin.isTTY) return null;
    const { show } = await prompts({
      type: "confirm",
      name: "show",
      message: `Pick from all ${open.length} open ticket(s) instead?`,
      initial: true,
    });
    if (!show) {
      log.dim(`  Assign one to yourself in ${adapter.title}, then run this again.`);
      return null;
    }
    tickets = open;
  }

  const { pick } = await prompts({
    type: "select",
    name: "pick",
    message: "Which ticket?",
    choices: tickets.map((t) => ({ title: `${t.ref}  ${t.title.slice(0, 70)}`, value: t.id })),
  });
  if (pick === undefined) return null;
  return tickets.find((t) => t.id === pick) ?? null;
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
