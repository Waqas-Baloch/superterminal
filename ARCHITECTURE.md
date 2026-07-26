# Super Terminal — architecture

A local-first CLI that sits between a developer and whichever AI coding agent
they use. It has no model of its own: it prepares the work, routes it to an
agent, then verifies what came back.

## The path a task takes

```
task (typed, or from a ticket)
  → trust        first contact with a repo: name its instruction files, ask once
  → index/map    scan the repo, build a symbol + element graph
  → select       rank and pick the smallest complete slice of context
  → gate         4-band classification, target preflight, clarification
  → manifest     task + rules + context + skills + fenced ticket data + code
  → agent        Claude Code / Cursor / Codex, or the Anthropic API
  → verify       protected paths, edit scope, acceptance criteria
  → review       a DIFFERENT vendor's agent checks the diff, read-only
  → report       PM-readable summary; backup for one-command revert
```

## Layout

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Command registration (commander) |
| `src/commands/` | One file per command — run, flow, compare, ticket, team, review… |
| `src/core/` | The thinking: selection, ranking, gate, clarify, criteria, review, trust, team |
| `src/core/semantic/` | parse5 (HTML/DOM) + ts-morph (JSX/TS) → element and symbol graph |
| `src/claude/` | Agent adapters: one JSONL event parser, per-vendor argv and safety modes |
| `src/trackers/` | GitHub / Linear / Jira adapters behind one interface |
| `src/report/` | Terminal UI — banner, spinner, diff, session input, run report |
| `src/util/` | Paths, config, credentials, limits, telemetry |

## Decisions worth knowing

**Local-first, no server.** Code, rules and credentials stay on the machine.
The team layer uses Git for sync and GitHub for approval (CODEOWNERS + branch
protection) rather than a service, because a protected branch genuinely blocks
an unauthorized merge while a check inside a CLI can be edited out of a fork.

**Verification happens outside the model.** Protected-path and edit-scope
checks are deterministic code, not a prompt. Asking a model to police itself is
not a control.

**Untrusted text is fenced, never promoted to instructions.** Ticket bodies and
mentioned files enter the manifest as data with explicit framing; a task string
is derived from a ticket's title only.

**State is split.** `.super-t/` holds shared standards that belong in the repo
(rules, context, skills, `team.json`, `config.json`) and local run state that
does not (backups, reports, flow output, caches). The CLI writes
`.super-t/.gitignore` so nobody has to remember which is which. Credentials
live in `~/.super-t/` at 0600, never in a repository.

**Everything is reversible.** Every run backs up what it touches before editing,
so `super-t revert` restores a run — or an entire multi-step flow.

See [docs/security-protocols.md](docs/security-protocols.md) for the threat
model and the gates each roadmap phase must pass.
