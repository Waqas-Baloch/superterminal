# Security Policy

Super Terminal is a trust product. We treat security reports as the highest-priority work in the repository.

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub Security Advisories** ("Report a vulnerability" on this repo) rather than public issues.

- Acknowledgement target: **48 hours**
- We coordinate a fix before any public disclosure and credit reporters (unless you prefer anonymity)
- In scope: the `super-t` CLI, its published npm package, its telemetry pipeline, and the documented handling of rules/skills/ticket content
- Out of scope: vulnerabilities in the underlying agent CLIs (Claude Code, Cursor, Codex) — report those to their vendors; we will gladly help route them

## What we promise users

- Your code goes only to the AI agent you chose — Super Terminal adds no destination for source code
- Telemetry cannot carry free text by construction (enumerated fields, tested)
- Credentials are stored in your home directory with 0600 permissions, never inside a repository
- We maintain a written threat model and review every change against it. Specific
  controls are visible in the source; the prioritised list of open gaps is kept
  private, because a ranked inventory of weak spots helps an attacker in a way
  that our implemented controls do not.
