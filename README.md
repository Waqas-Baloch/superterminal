# Super Terminal

**One control layer for every AI coding agent.**

Super Terminal is a free, local-first CLI that sits between you and Claude Code, Cursor, or ChatGPT Codex. Write your project's rules once and every agent follows them. Chain several agents into a single workflow. Keep only the changes you meant.

It is not an agent. It has no model of its own and writes no code — it orchestrates the agent you already pay for.

## Install

Node 20+ required.

```sh
npm install -g superterminal
super-t connect          # one-time: pick your agent
super-t run "add a loading state to the checkout button"
```

## Why

Two problems, both familiar if you code with agents daily.

**Agents do more than you asked.** You say "remove the button in the navbar", there are two identical buttons, and it removes both. Or it rewrites the text instead of deleting it. Or it tidies three files you never mentioned.

**Your setup is locked to one vendor.** Rules live in `CLAUDE.md`, or `.cursorrules`, or `AGENTS.md` — each tied to one tool. Switch agents and you start over. No vendor will fix this, because none of them has a reason to make your rules work inside a competitor's product.

## What it does

### Asks before it guesses

Every request is sorted into one of four bands: run it, infer the obvious detail, ask a clarifying question, or refuse. When your description matches two identical elements, you get asked which one — instead of finding out in code review. When the thing you named doesn't exist, you're told before an agent goes looking for it.

### Your rules follow you to every agent

Super Terminal reads the instruction files you already have — `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.super-t/rules.md`, `context.md`, and skill files — and applies all of them to whichever agent runs the task.

```sh
super-t init             # draft a starter .super-t/rules.md
```

Drop a `context.md` in your project and every agent gets the same background.

### Verifies after the run, not just before

A rule saying "never modify `src/generated`" isn't a suggestion. Super Terminal checks the files that actually changed once the agent finishes — whichever agent it was — and offers to restore anything that broke the rule.

### Chains agents into one workflow

```sh
super-t flow "audit auth with claude,
              then fix the findings with cursor,
              then review the diff with codex"
```

One command. Each step runs on the agent you named, and each step's output is handed to the next.

### Compares agents on the same task

```sh
super-t compare "tighten the error handling in the payment module"
```

Runs one task through every connected agent so you can keep the best result.

### Shows what changed, and undoes it

Not just `+12 −4` but *"styles and attributes only — no symbols or copy affected."*

```sh
super-t revert           # restore the last run
```

## Commands

| Command | What it does |
|---|---|
| `super-t run "task"` | Start a session and run tasks until you exit |
| `super-t plan "task"` | Preview what would be sent — nothing is sent |
| `super-t flow "a, then b"` | Multi-step, multi-agent workflow |
| `super-t compare "task"` | Same task through every connected agent |
| `super-t connect` | One-time setup — pick your agent |
| `super-t switch` | Change the active agent |
| `super-t search` | Switch project |
| `super-t init` | Draft a starter rules file |
| `super-t revert` | Restore files from the last run |
| `super-t forget` | Clear learned disambiguation choices |
| `super-t telemetry` | Show or change anonymous usage counting |

## Supported agents

Claude Code, Cursor, and ChatGPT Codex. Super Terminal uses the subscription you already have — it never asks for a separate API key of its own.

## Privacy

Your code goes only to the AI agent you chose, the same place it already goes when you use that agent directly. Super Terminal adds no separate destination for your source code.

It does send anonymous usage counts — which agent, which command, whether a task finished, plus version and OS. Never your prompts, filenames, paths, code, diffs, or repo names; the fields that may be transmitted are enumerated in [`src/util/telemetry.ts`](src/util/telemetry.ts) and covered by tests.

```sh
super-t telemetry off    # or: SUPER_T_TELEMETRY=0, or DO_NOT_TRACK=1
```

## Upgrading from Glint

Super Terminal was previously published as `getglint` with the `glint` command.

```sh
npm uninstall -g getglint
npm install -g superterminal
```

Your existing setup keeps working. Connections, project rules, learned choices, and run backups written under `.glint/` (and `~/.glint/`) are still read, so you don't need to reconnect or lose an undo. New state is written to `.super-t/`. The `GLINT_*` environment variables are still honoured — including `GLINT_TELEMETRY=0`, so an existing opt-out stays an opt-out.

## Requirements

Node 20 or later. macOS and Linux are tested; Windows is untested.

## License

MIT
