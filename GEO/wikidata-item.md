# Wikidata item for Super Terminal

Every property and item ID below was checked against the live Wikidata API on
2026-08-05. Two I could not verify are flagged — search for those rather than
trusting a number from here.

---

## Read this first: it may be deleted

Wikidata is not a promotional venue, and items get nominated for deletion.
[WD:N](https://www.wikidata.org/wiki/Wikidata:Notability) accepts an item if it
"refers to an instance of a clearly identifiable conceptual or material entity"
that "can be described using serious and publicly available references."

**Where you stand against that:**

| | |
|---|---|
| Clearly identifiable entity | Yes — a published npm package with a version history |
| Publicly available references | Yes — npm, GitHub, your own site |
| Third-party coverage | **None** — no press, no reviews, no independent write-ups |
| Age | Repository created 11 July 2026 |

The first two are what the policy asks for, so the item is defensible. But items
for young software with no third-party coverage are the ones most often
nominated, and an editor who reads it as self-promotion will act on that
impression rather than the policy text.

**Two things decide which way it goes:**

1. **Every statement carries a reference.** An unreferenced item looks like
   someone advertising. A fully referenced one looks like someone maintaining a
   database. This is the single biggest factor and it is entirely in your control.
2. **The description reads as a fact, not a pitch.** See below.

**Do not create a Wikipedia article.** That bar is much higher — it needs
significant coverage in independent secondary sources, which does not exist yet.
A Wikipedia article now would be deleted, and a deletion is a worse starting
point than nothing.

Consider waiting until after the September launch if a Hacker News thread or a
write-up materialises. Wikidata will still be there, and the item will be far
harder to challenge.

---

## Label, description, aliases

**Label (en):** `Super Terminal`

**Description (en):**

```
command-line tool that applies one set of project rules across multiple AI coding agents
```

Wikidata description conventions, all of which matter for survival: **no capital
letter at the start** (unless a proper noun), **no full stop at the end**, **no
"is a"**, and no marketing language. Keep it under about 250 characters.

Do **not** write "the control layer for AI coding agents" or anything with
"powerful", "seamless" or "revolutionary" — that reads as advertising and is what
gets an item flagged.

**Aliases (en):** `super-t`

Add only genuine alternative names. `super-t` qualifies because it is the actual
command and package name. Do not stuff keywords here; alias fields are not a
search-optimisation surface and treating them as one is visible.

---

## Statements

Each row is `property → value`, with the reference to attach. Property and item
IDs marked ✅ were verified live.

| Property | Value | Reference to attach |
|---|---|---|
| ✅ **P31** instance of | ✅ **Q7397** software | npm package page |
| ✅ **P31** instance of | ✅ **Q1077784** programming tool | npm package page |
| ✅ **P277** programmed in | ✅ **Q978185** TypeScript | GitHub repository |
| ✅ **P400** platform | ✅ **Q756100** Node.js | npm package page |
| ✅ **P856** official website | `https://superterminal.dev` | the site itself |
| ✅ **P1324** source code repository URL | `https://github.com/Waqas-Baloch/superterminal` | the repository |
| ✅ **P178** developer | Waqas Baloch | GitHub repository |
| ✅ **P571** inception | `2026-07-11` | repository creation date |
| ✅ **P348** software version identifier | `2.4.0` | npm package page |
| ✅ **P306** operating system | macOS, Linux, Windows | README / CI matrix |
| ⚠️ **P275** copyright license | search Wikidata for **FSL-1.1-MIT** | LICENSE file |

### On P178 (developer)

This wants a Wikidata **item**, not a text string. You almost certainly do not
have one, and **creating an item about yourself is the fastest route to a
deletion nomination.** Skip this property entirely. An item without a developer
statement is normal; an item that looks like a person promoting themselves is not.

### On P275 (copyright license)

I could not verify a Wikidata item for **FSL-1.1-MIT** — the licence is new and
may not have one yet. Search Wikidata for "Functional Source License" before
adding anything.

- **If an item exists**, use it.
- **If it does not, leave the property off.** Do not substitute the MIT item.
  Super Terminal is not MIT-licensed today; it becomes MIT two years after each
  release. Stating MIT now would be factually wrong, and a wrong statement is far
  more damaging than a missing one.

### On P348 (software version identifier)

Add a qualifier **P577 publication date** with the release date, and expect to
update it. A version statement that is six months stale looks abandoned, which is
worse for how the item is read than having no version at all.

---

## How to reference a statement

This is the part people skip, and it is what decides whether the item survives.

For each statement, add a reference block with:

- **P854** reference URL → the exact page proving it
  (`https://www.npmjs.com/package/super-t`)
- **P813** retrieved → today's date

The npm package page is the strongest single reference you have: independent of
you, publicly verifiable, machine-readable, and it proves the software exists, is
published, and has the stated version.

---

## What to leave out

- **Anything unverifiable.** No user counts, no download figures. npm downloads
  count bots and mirrors and would not survive scrutiny.
- **Feature lists.** Wikidata stores facts about an entity, not what it can do.
  There is no property for "asks clarifying questions" and inventing a way to
  express it reads as promotion.
- **Comparisons to other tools.** Nothing that positions the item against Claude
  Code, Cursor or Codex.
- **The word "free".** It is free of charge, but "free software" has a specific
  meaning that FSL does not meet. Saying it invites a correction and undermines
  the rest of the item.

---

## Why this is worth doing at all

Wikidata feeds the knowledge graphs that AI answer engines draw on, and a
structured, referenced item is exactly the kind of source they treat as
authoritative. It is one of the few places where a small project can sit in the
same structured dataset as a large one.

But be clear about what it does and does not move. The current visibility run
shows **0 mentions across 26 non-brand questions** and **0 citations across all
34 answers**. A Wikidata item does not fix that. What it does is make the entity
resolvable — so when an engine already has the name, it has a structured record
to draw facts from, which is why the brand-tier questions score 3/3 while
everything else scores nothing.

In other words: this strengthens the tier that already works. The 26 questions
that score zero are answered by the landing page and by community presence, not
by Wikidata.

**Sequence it accordingly.** The landing page work and a dev.to or Reddit
presence move the number that is currently zero. Wikidata is worth an hour, is
best done after there is something third-party to reference, and should not
displace either.
