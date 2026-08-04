# Super Terminal

**One rulebook for every AI coding agent.**

Super Terminal sits between you and Claude Code, Cursor, or ChatGPT Codex. Write your project's rules once and every agent follows them — then a *different* vendor's AI checks the work against those rules before you keep it.

Free, local-first, and it uses the AI subscription you already pay for. It is not an agent: it has no model of its own and writes no code.

## Install

Node 20+ required.

```sh
npm install -g super-t
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
| `super-t ticket [id]` | Implement a tracker ticket — gated, cross-vendor-verified, summary posted back with your approval |
| `super-t tracker connect` | Connect Linear or Jira (GitHub Issues needs no setup — it uses `gh`) |
| `super-t resume [--with agent]` | Continue the last task — with any vendor |
| `super-t doctor` | Check agents, connection, trackers, and project state |
| `super-t skills sync` | One skill set for every agent — materialize to native formats |
| `/create skill` · `/create agent` | Scaffold a new skill or agent from inside a session |
| `/skills` | Search the skills this project can use |
| `super-t team init` | Shared standards with admin approval (Git + GitHub, no server) |
| `super-t team invite octocat` | Invite a developer by their GitHub username (beta: up to 5) |
| `super-t team propose "why"` | Send your standards change for admin approval as a pull request |
| `super-t feedback octocat` | Ask a person to review your last run — arrives as a GitHub issue |
| `super-t review codex --always` | A different vendor checks every change, in every project |
| `super-t connect` | One-time setup — pick your agent |
| `super-t switch` | Change the active agent |
| `super-t search` | Switch project, or create a new one |
| `super-t init` | Draft a starter rules file |
| `super-t revert` | Restore files from the last run |
| `super-t forget` | Clear learned disambiguation choices |

## Teams

Standards live in your repository, so Git is the sync layer and GitHub is the approval mechanism — there is no server and no account.

```sh
super-t team init                    # you become admin; writes .github/CODEOWNERS
super-t team invite octocat          # their real GitHub username
super-t team status                  # who's admin, and whether your standards are current
```

Every member gets the same rules, context, and skills on `git pull`. If a non-admin edits a governed file, Super Terminal says so before any agent runs — because those local edits would otherwise govern that run — and `super-t team propose "what changed"` sends them for approval as a pull request.

To make approval **enforced** rather than advisory, protect your default branch and enable *Require review from Code Owners*. Super Terminal can warn; only GitHub can block a merge.

Beta: teams up to 5 members, free.

## Supported agents

Claude Code, Cursor, and ChatGPT Codex. Super Terminal uses the subscription you already have — it never asks for a separate API key of its own.

## Questions

### Why does an AI coding agent change files I didn't ask it to?

AI coding agents act on the most likely reading of a request, and when a request
is ambiguous the most likely reading is often wrong. Ask one of two identical
buttons to be removed and the agent has no way to know which, so it picks — or
removes both. Super Terminal sorts every request into one of four bands and asks
a clarifying question instead of guessing when the description matches more than
one thing.

### How do I make Cursor follow the rules in my CLAUDE.md?

Cursor does not read `CLAUDE.md` — that file is Claude Code's, and Cursor uses
`.cursorrules` instead. Super Terminal reads whichever instruction files a
project already has, including `CLAUDE.md`, `.cursorrules` and `AGENTS.md`, and
applies all of them to whichever agent runs the task.

### Can I use the same coding rules for Claude Code, Cursor and Codex?

Yes, with a tool that sits above all three. Each vendor reads only its own
instruction file, so rules written for one are invisible to the others. Super
Terminal reads every one of those files and gives their combined contents to
whichever agent is running.

### How can I have one AI review another AI's code?

Run the two through a layer that is not owned by either vendor. Super Terminal
has Claude Code write the change and a different vendor's agent review it against
the project's rules, then reports what it found in plain English. The reviewer
runs read-only and is verified read-only after the fact, because a reviewer that
can edit is not a reviewer.

### How do I verify an AI coding agent met the ticket's requirements?

Parse the acceptance criteria out of the ticket and check each one separately
after the run. Super Terminal pulls a ticket from GitHub Issues, Linear or Jira,
finds its acceptance criteria, and has a second AI judge each criterion as met,
not met, or unknown — then posts that summary back to the ticket if you approve
it.

### How do I undo everything an AI coding agent just did?

Every Super Terminal run is backed up before it starts, so `super-t revert`
restores the files an agent changed in one command. Multi-step workflows are
covered too: a chain that goes wrong at step three rolls back all three steps,
not just the last one.

### What is Super Terminal?

Super Terminal is a free command-line tool that sits between a developer and the
AI coding agents they already pay for. Super Terminal makes Claude Code, Cursor
and ChatGPT Codex follow one shared set of project rules, and has a different
vendor's AI check the work before the developer keeps it. Super Terminal has no
model of its own and writes no code.

### Does Super Terminal need its own API key?

No. Super Terminal uses the Claude, Cursor or ChatGPT subscription a developer
already has, and never asks for a separate API key.

### Is Super Terminal open source?

Super Terminal is source-available, not open source. The full source is public
and readable, the licence permits any use including commercial work, and each
release becomes MIT two years after it ships. The single restriction is selling a
competing product built from it.

## Privacy

Your code goes only to the AI agent you chose, the same place it already goes when you use that agent directly. Super Terminal adds no separate destination for your source code.

The first time you use Super Terminal in a repository, it names every file that will be sent to your agent as instructions — `CLAUDE.md`, `AGENTS.md`, rules, skills — and asks once. A repository you cloned can contain instructions you never wrote, and this is where you find out. If that content looks like it is trying to steer the agent (telling it to ignore instructions, read credentials, or pipe a script to a shell), Super Terminal says so and defaults to "no".

It does send anonymous usage counts — which agent, which command, whether a task finished, plus version and OS. Never your prompts, filenames, paths, code, diffs, or repo names; the fields that may be transmitted are enumerated in [`src/util/telemetry.ts`](src/util/telemetry.ts) and covered by tests.

```sh
super-t telemetry off    # or: SUPER_T_TELEMETRY=0, or DO_NOT_TRACK=1
```

## Developing

```sh
git clone https://github.com/Waqas-Baloch/superterminal.git
cd superterminal
npm install
npm test          # 429 tests
npm run build     # then run it with: node dist/cli.js
```

`npm run typecheck` and `npm test` both run in CI on Linux, macOS and Windows
across Node 20 and 24, so run them before opening a pull request.
[AGENTS.md](AGENTS.md) holds the standards any contributor — human or AI —
should follow in this repo.

## Requirements

Node 20 or later. Linux, macOS and Windows are tested in CI on every commit.

## License

Source-available under the [Functional Source License](LICENSE) (`FSL-1.1-MIT`):
free for any use including commercial and internal work, readable in full, and
it becomes MIT two years after each release. The only restriction is selling a
competing product built from it. Plain-English summary: [LICENSING.md](LICENSING.md).

Versions up to 1.9.x were released under MIT and remain so.
