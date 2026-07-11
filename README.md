# Glint

Local-first CLI that cuts LLM token spend by compressing your codebase into a **task-specific manifest** before sending it to your AI coding agent — Claude, Cursor, or ChatGPT. Same model, 5–10× less context, with seatbelts.

Works on TypeScript/JavaScript/HTML/CSS repos; tuned for React/Next.js.

## Install

One command (Node 20+ required):

```sh
npm install -g @waqasbaloch/glint
```

Then verify and connect:

```sh
glint --version
glint connect
```

> macOS/Linux: if npm complains about permissions, either run the command with `sudo`, or point npm at a user directory once: `npm config set prefix ~/.local` (make sure `~/.local/bin` is on your PATH).

Alternatives:

```sh
npm install -g github:Waqas-Baloch/glint   # straight from GitHub (needs git)

git clone https://github.com/Waqas-Baloch/glint && cd glint
npm install && npm run build && npm link    # local development
```

## Connect (one time)

```sh
glint connect
```

Pick how Glint talks to Claude:

| Option | What it needs | Notes |
|---|---|---|
| **Anthropic API key** | Key from console.anthropic.com | Verified, then stored in `~/.glint/config.json` (chmod 600) |
| **Browser login** | The `ant` CLI installed | Opens `ant auth login` — no key ever stored |
| **Claude Code** | The `claude` CLI installed | Reuses your Claude subscription; edits tracked and undone via git |
| **Cursor** | The `cursor-agent` CLI installed | Reuses your Cursor subscription; same git-based tracking |
| **ChatGPT (Codex)** | The `codex` CLI installed (`npm i -g @openai/codex`) | Reuses your ChatGPT plan; same git-based tracking |

`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env vars always take precedence over the stored connection (for CI).

## Usage

```sh
# Dry run — see exactly what would be selected and sent (no API call)
glint plan "add checkout form"

# Start a session: runs the task, then keeps taking tasks until /exit
glint run "add checkout form"
glint run              # start an empty session

# Undo the last run
glint revert
```

In a terminal, `glint run` is a persistent session — after each task finishes you're prompted for the next one, chat-style, until `/exit` or Ctrl-C. With `--yes` or piped input it behaves as a single-shot command for scripts/CI.

If your chosen agent CLI (Claude Code / Cursor / Codex) isn't installed, `glint connect` offers to install it and run its login for you.

`glint run` flags:

| Flag | Effect |
|---|---|
| `--budget <tokens>` | Manifest token budget (default 30000) |
| `--model <id>` | Claude model (default `claude-opus-4-8`) |
| `-y, --yes` | Skip the confirmation prompt |
| `--no-validate` | Skip tsc/eslint/test after edits |

## How it works

1. **Index** — scans the repo (respects `.gitignore`, skips lockfiles/binaries)
2. **Map** — builds an import graph + exported symbols via ts-morph (resolves `@/` aliases)
3. **Select** — BM25 relevance over paths/symbols/content + 1-hop graph expansion + schema boosts, greedily filled under the token budget
4. **Manifest** — one dense Markdown doc: project facts, full text for primary files, signatures for secondary files
5. **Edit loop** — Claude works through 4 narrow tools (`read_file`, `list_files`, `str_replace`, `write_file`). No shell, no network. Edits are staged, originals backed up to `.glint/backup/`, then applied
6. **Validate** — runs `tsc --noEmit`, `eslint`, and `npm test` (each only if the repo has it configured); failures are fed back to Claude for up to 2 repair rounds
7. **Report** — colored unified diff, touched-file summary, token usage + cost

## Config (optional)

`.glintrc.json` in your repo root:

```json
{
  "model": "claude-opus-4-8",
  "budgetTokens": 30000,
  "include": ["extra/glob/**"],
  "exclude": ["generated/**"]
}
```

## Safety model

- Claude can only read repo files and stage edits — no bash, no network, no paths outside the repo
- `.git`, `node_modules`, lockfiles, and `.glint` are never editable
- Every modified file is backed up before writing; `glint revert` restores the last run in one command
- Nothing is sent anywhere until you confirm (or pass `--yes`)

## Development

```sh
npm run typecheck && npm test   # 71 tests, all offline
npm run dev                     # rebuild on change
```
