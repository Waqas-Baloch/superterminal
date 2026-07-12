# Security

Glint is a local-first CLI. It runs entirely on your machine — there is no Glint
server, no telemetry, and no analytics. The only network traffic is between your
machine and the AI provider you explicitly connect (Anthropic, or the Claude
Code / Cursor / ChatGPT CLIs).

## What data leaves your machine

- **Only the manifest**, and only after you confirm. Glint compresses the
  relevant slice of your repo into a manifest and shows you a token count before
  sending. Run `glint plan "task"` to see exactly what would be sent — it makes
  no network calls.
- The manifest goes to **your chosen AI provider** under **your own account**.
  Glint stores no copy and routes nothing through any third party.
- **Be aware secrets in your code can be included.** If a selected file contains
  an API key or password, it becomes part of the manifest. Glint never indexes
  `.env` files (only `.env.example`) and skips lockfiles and binaries, but it
  cannot detect a secret hard-coded in source. Use `glint plan` to review, and
  keep secrets in `.env`/secret managers, not in source.

## Credentials

- The API-key connection is stored in `~/.glint/config.json` with `0600`
  permissions (owner read/write only).
- Browser-login and agent-CLI connections store **no key** — auth lives in the
  provider's own CLI (`ant`, `claude`, `cursor-agent`, `codex`).
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` environment variables always take
  precedence over the stored connection, so CI never needs the config file.

## File edits are bounded and reversible

- In API mode, the AI can only use four tools — `read_file`, `list_files`,
  `str_replace`, `write_file`. **No shell, no network.** Every path is resolved
  and rejected if it escapes the repo root; `.git`, `node_modules`, lockfiles,
  and `.glint` are never editable.
- Edits are **staged in memory**, the originals are **backed up**, then applied.
  In agent-CLI mode, Glint snapshots your files before the run and diffs against
  the snapshot afterward (no git required). Either way, **`glint revert`**
  restores the last run from the backup.

## Running in untrusted repositories

Glint runs your project's configured checks after edits — `tsc`, `eslint`, and
`npm test`. Those execute code and config **from the repository** (e.g. a
`test` script, an ESLint plugin). This is standard for any tool that runs your
tests, but it means you should only run Glint in repositories you trust, or pass
`--no-validate` to skip the checks. The AI agents (Claude Code / Cursor / Codex)
also act on repo contents, so the same trust applies to the manifest content
(prompt-injection text in a malicious repo could influence the agent).

## Subprocesses

Glint shells out to `git` and the provider/validator CLIs using argument arrays
(never string interpolation), so repository paths and task text cannot inject
shell commands. The only `shell: true` call is a fixed, built-in install command
in `glint connect`, never user input.

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories on the repository,
or email the maintainer. Do not file public issues for security reports.
