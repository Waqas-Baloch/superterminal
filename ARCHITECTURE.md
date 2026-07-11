# Glint — MVP Architecture (v1)

Local-first CLI that compresses a TS/JS repo into a task-specific manifest, runs a Claude edit loop against it, validates locally, and reports a diff.

## Pipeline

```
glint run "add checkout form"
   │
   ▼
[1] indexer    scan repo (fast-glob + .gitignore), file metadata, hashes → .glint/index.json
   ▼
[2] mapper     ts-morph: imports/exports, exported symbols per file → dependency graph
   ▼
[3] selector   score files vs task (BM25 over paths/symbols/content + 1-hop graph expansion
               + boosts for routes/schemas/configs) → ranked set under token budget
   ▼
[4] manifest   dense Markdown: project facts, selected-file tree, full text of primary files,
               signatures-only for secondary files, schemas, the task → single string
   ▼
   confirm     show selected files + token estimate, ask y/N (skip with --yes)
   ▼
[5] runner     Claude tool loop (@anthropic-ai/sdk toolRunner): read_file / str_replace /
               write_file tools, edits staged then applied; originals backed up to .glint/backup
   ▼
[6] validator  tsc --noEmit → eslint → npm test (each only if configured); on failure,
               feed error tail back to runner, max 2 repair iterations
   ▼
[7] reporter   unified diff per touched file, file list, token usage + cost
```

`glint plan "<task>"` runs [1]–[4] only and prints the manifest + estimate (dry run).
`glint revert` restores `.glint/backup` from the last run.

## Folder structure

```
glint/
├── src/
│   ├── cli.ts               # commander entry, flags: --budget --model --yes --no-validate
│   ├── commands/
│   │   ├── run.ts
│   │   ├── plan.ts
│   │   └── revert.ts
│   ├── core/
│   │   ├── indexer.ts       # scan, hash, cache to .glint/index.json
│   │   ├── mapper.ts        # ts-morph import graph + exported symbols
│   │   ├── selector.ts      # minisearch BM25 + graph expansion + heuristic boosts
│   │   └── manifest.ts      # markdown generation under token budget
│   ├── claude/
│   │   ├── runner.ts        # SDK tool-runner loop, streaming, prompt caching
│   │   ├── tools.ts         # betaZodTool defs: read_file, str_replace, write_file
│   │   └── prompts.ts       # system prompt (frozen, cache_control on last block)
│   ├── validate/
│   │   └── validator.ts     # execa: tsc / eslint / test, capture error tails
│   ├── report/
│   │   └── diff.ts          # `diff` package rendering + touched-file summary
│   └── util/
│       ├── tokens.ts        # chars/4 estimate; count_tokens API for final check
│       ├── config.ts        # .glintrc.json (model, budget, ignore extras)
│       └── logger.ts
├── package.json             # bin: { "glint": "dist/cli.js" }
├── tsconfig.json
└── tsup.config.ts
```

## Key decisions

**Relevance (matters most).** Hybrid lexical + structural, no embeddings in MVP:
1. Tokenize the task into terms (`checkout`, `form`) + expansions (`cart`, `payment` via a small synonym map for common web-app domains).
2. BM25 (minisearch) over an index of: file path segments, exported symbol names, and content.
3. Expand the top hits 1 hop along the import graph (a component's hooks/types/api client come along).
4. Static boosts: `package.json`, `tsconfig`, Next.js route files touching matched terms, `schema.prisma`, zod schemas, tailwind/theme config.
5. Greedy fill under the token budget (default 30k tokens): top files get full text, next tier gets ts-morph–extracted signatures only, rest is just tree entries.

**Claude runner.** `@anthropic-ai/sdk` beta tool runner, model `claude-opus-4-8`, `thinking: {type:"adaptive"}`, streaming. Manifest goes in the first user message; the frozen system prompt carries `cache_control: {type:"ephemeral"}` so repair iterations hit the prompt cache. Tools are the safety boundary:
- `read_file(path)` — any repo file (escape-proof: resolve + verify inside repo root)
- `str_replace(path, old, new)` / `write_file(path, content)` — staged in memory, applied only after the turn ends; every touched original copied to `.glint/backup/<run-id>/` first
- No bash tool. No network tools. Claude can only read and propose edits.

**Safe edit loop.** Apply staged edits → run validators → if red, send only the error tail (last ~100 lines) back as a follow-up message on the same conversation (cache hit) → max 2 repairs → if still red, keep edits but exit non-zero with the failure shown. `glint revert` always available; if the repo is git, we also print `git checkout -- <files>` hints.

**Validators.** Detected, never assumed: `tsc --noEmit` if tsconfig.json exists, `eslint` if an eslint config exists, `npm test` only if the script exists and isn't the npm placeholder. Run via execa with a 3-minute timeout each.

## Packages

| Purpose | Package | Why |
|---|---|---|
| CLI framework | `commander` | boring, tiny |
| Repo scan | `fast-glob` + `ignore` | .gitignore-correct scanning |
| Symbols/graph | `ts-morph` | one lib for imports, exports, signatures |
| Lexical scoring | `minisearch` | in-memory BM25, zero infra |
| Claude | `@anthropic-ai/sdk` | tool runner, streaming, caching |
| Tool schemas/config | `zod` | also required by betaZodTool |
| Subprocesses | `execa` | validator runner |
| Diff rendering | `diff` | works without git |
| UX | `picocolors`, `ora`, `prompts` | color, spinner, y/N confirm |
| Build/test | `tsup`, `vitest` | fast, standard |

## Out of scope for v1
Embeddings, watch mode, multi-repo, IDE integration, auto-commit/merge, non-TS languages, cloud anything.
