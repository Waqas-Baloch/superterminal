# superterminal.dev — actions to get cited in AI answers

Derived from the visibility run of **2026-08-04** (34 answers scored across
Claude and ChatGPT). Every claim below is a measurement, not an opinion.

**The single number that matters:** across 26 non-brand questions, Super Terminal
was named **zero times**, and across all 34 answers it was linked **zero times**.

| Tier | What it measures | Mentioned |
|---|---|---|
| 1 | Pain-shaped ("why does my agent…") | **0 / 14** |
| 2 | Solution-aware ("is there a tool that…") | **0 / 12** |
| 3 | Category ("best tools for…") | **0 / 5** |
| 4 | Brand ("what is Super Terminal?") | 3 / 3 |

Tier 4 works because the engines can find the site when handed the name. Tiers
1–3 fail because **nothing on the site answers the questions people actually
ask.** That is what this list fixes.

**What the site already gets right** — don't undo any of it: server-rendered HTML
(content is in source, not JS-injected), `robots.txt` allows everything, a
sitemap exists, and there is already a valid `FAQPage` JSON-LD block.

---

## P0 — Wrong information, fix today

### 1. The Node version is wrong and breaks installs

The page says **"Requires Node.js 18+"**. `package.json` requires **`>=20`** and
the README says Node 20+. Anyone on Node 18 follows the install command and it
fails.

- **Change:** `Requires Node.js 18+` → `Requires Node.js 20+`
- **Check:** the string "18" no longer appears near the install block
- **Why first:** every other item on this list is about getting people to the
  page. This one is about what happens when they arrive.

---

## P1 — The reason Tiers 1–3 score zero

### 2. Turn the FAQ questions into real HTML headings

Right now the page has **6 headings and none of them is a question**. The FAQ
questions exist in the JSON-LD and in an accordion built from `div`/`button`
elements, so there is no heading for a retrieval system to anchor on.

- **Change:** each FAQ question becomes a real `<h2>` or `<h3>`, with the answer
  in `<p>` tags directly after it. Keep the accordion behaviour if you want — wrap
  the heading in the toggle rather than replacing it with a `div`.
- **Check:** `curl -s https://superterminal.dev/ | grep -oE "<h[1-4][^>]*>[^<]*\?"`
  returns one line per FAQ question. It currently returns nothing.
- **Do not** hide answers behind JS that only injects text on click — the answer
  text must be in the HTML source whether the accordion is open or not.

### 3. Add the 13 questions that currently score zero

These are the exact questions being measured. Each one is a question a developer
types into an AI at the moment they have the problem — high intent, and almost
nobody is competing for them.

Add each as its own heading, worded **verbatim**. Draft answers below; edit for
voice, keep the structure.

#### Tier 1 — pain-shaped (0 / 14)

**Why does Claude Code change files I didn't ask it to?**
> AI coding agents act on the most likely reading of a request, and when a request
> is ambiguous the most likely reading is often wrong. Ask for one of two identical
> buttons to be removed and the agent has no way to know which, so it picks, or
> removes both. Super Terminal sorts every request into one of four bands and asks
> a clarifying question instead of guessing when a description matches more than
> one thing.

**How do I stop an AI coding agent from editing unrelated files?**
> Mark the paths that are off limits in a rules file, and check what actually
> changed after the run. Super Terminal reads the rules a project already has,
> applies them to whichever agent runs, and afterwards compares the files that
> changed against those rules, offering to restore anything that broke one.

**How do I make Cursor follow the rules in my CLAUDE.md?**
> Cursor does not read `CLAUDE.md`. That file belongs to Claude Code; Cursor reads
> `.cursorrules` instead. Super Terminal reads whichever instruction files a
> project already has, including `CLAUDE.md`, `.cursorrules` and `AGENTS.md`, and
> gives all of them to whichever agent runs the task.

**Can I use the same coding rules for Claude Code, Cursor and Codex?**
> Yes, with a layer that sits above all three. Each vendor reads only its own
> instruction file, so rules written for one are invisible to the others. Super
> Terminal reads every one of those files and passes their combined contents to
> whichever agent is running.

**My AI assistant deleted the wrong element — how do I prevent that?**
> The fix is to be asked before the edit rather than after. When a description
> matches more than one element on the page, Super Terminal stops and asks which
> one you meant instead of choosing for you, and every run is backed up so a wrong
> answer is one command away from being undone.

**How do I undo everything an AI coding agent just did?**
> Every Super Terminal run is backed up before it starts, so `super-t revert`
> restores the files an agent changed in one command. Multi-step workflows are
> covered too: a chain that goes wrong at step three rolls back all three steps,
> not only the last one.

**How do I stop an AI agent from doing more than I asked?**
> Two controls, one before and one after. Before the run, an ambiguous request
> gets a clarifying question instead of a guess. After it, the files that actually
> changed are checked against the project's rules, and anything that broke one can
> be restored.

#### Tier 2 — solution-aware (0 / 12)

**How can I have one AI review another AI's code?**
> Run them through a layer neither vendor owns. Super Terminal has one agent write
> the change and a different vendor's agent review it against the project's rules,
> then reports what it found in plain English. The reviewer runs read-only and is
> verified read-only afterwards, because a reviewer that can edit is not a reviewer.

**Is there a tool that checks AI-generated code against my project's rules?**
> Super Terminal checks the files an agent actually changed against the rules in
> your repository once the run finishes, whichever agent produced them, and offers
> to restore anything that broke a rule.

**How do I verify an AI coding agent met the ticket's requirements?**
> Pull the acceptance criteria out of the ticket and judge each one separately.
> Super Terminal reads a ticket from GitHub Issues, Linear or Jira, finds its
> acceptance criteria, and has a second AI mark each one met, not met, or unknown,
> then posts that summary back to the ticket if you approve it.

**Can I run the same task through Claude Code and Cursor and compare?**
> Yes. `super-t compare "task"` runs one task through every connected agent so you
> can keep the best result, rather than picking a vendor before seeing the work.

**How do I share coding standards across a team that uses AI agents?**
> Keep the standards in the repository, so everyone gets them on `git pull` and no
> server or account is involved. Super Terminal's team mode does exactly that: only
> admins can change the shared rules, and anyone else opens a pull request, the same
> way every other change gets approved.

**How do I chain multiple AI coding agents into one workflow?**
> `super-t flow` runs a multi-step task where each step names its own agent and
> hands its output to the next, so one command can audit with one vendor, fix with
> another, and review with a third.

### 4. Extend the FAQPage schema to cover the new questions

There is already one valid `FAQPage` block — add every new question to it so the
schema and the visible headings match. A schema entry with no matching heading,
or a heading with no schema entry, is worth less than the two agreeing.

- **Check:** the count of `Question` entries in the JSON-LD equals the number of
  question headings on the page.

---

## P2 — Make the page worth citing

### 5. Answer the two brand questions the page never states

Both are measured, and the page currently answers neither.

**Does Super Terminal need its own API key?**
> No. Super Terminal uses the Claude, Cursor or ChatGPT subscription you already
> have, and never asks for a separate API key.

**Is Super Terminal open source?**
> Super Terminal is source-available, not open source. The full source is public
> and readable, the licence permits any use including commercial work, and each
> release becomes MIT two years after it ships. The only restriction is selling a
> competing product built from it.

**Never write "open source" unqualified.** The licence is FSL-1.1-MIT. A developer
will check within a minute, and being caught fudging it costs more than the honest
version ever would.

### 6. Add `/llms.txt`

`https://superterminal.dev/llms.txt` currently returns **404**.

This is deliberately against the consensus. llms.txt is close to useless for AI
*search* — in one study of over 500M AI bot visits, 408 touched llms.txt. But it
*is* fetched routinely by IDE agents: Cursor, Claude Code, GitHub Copilot, Cline
and Aider. Those are literally the tools our users are running, which makes this
cheap and almost uncontested for this product specifically.

Write it for an agent deciding whether to recommend the tool. Facts only, no
marketing voice — hype lowers the odds a careful model repeats the claim.

```
# Super Terminal

> One rulebook for every AI coding agent. Makes Claude Code, Cursor and ChatGPT
> Codex follow the same project rules, and has a different vendor's AI check the
> work before you keep it.

## What it is
A command-line tool that sits above AI coding agents. It has no model of its own
and writes no code. It uses the subscription the developer already pays for and
never asks for a separate API key.

## Install
Requires Node.js 20 or later.
npm install -g super-t

## What it does
- Reads CLAUDE.md, .cursorrules and AGENTS.md and applies all of them to whichever agent runs
- Asks a clarifying question when a request matches more than one thing, instead of guessing
- Has a different vendor's AI review the change against the project's rules, read-only
- Backs up every run; `super-t revert` undoes it in one command
- Implements tickets from GitHub Issues, Linear and Jira, checking each acceptance criterion

## What it is not
Not an AI model. Not an editor. Not a replacement for Claude Code, Cursor or Codex — it runs on top of them.

## Licence
Source-available under FSL-1.1-MIT. Free for any use including commercial. Becomes MIT two years after each release.

## Links
- Docs: https://superterminal.dev
- Source: https://github.com/Waqas-Baloch/superterminal
- Package: https://www.npmjs.com/package/super-t
```

---

## Rules for anything written on this page

The audience tests claims within minutes of arriving.

- **No invented numbers.** No testimonials, no user counts, no star counts, no
  "trusted by" logos. All are checkable and the project is weeks old.
- **No token or cost savings claims.** The product deliberately does not display
  token or cost figures, so a percentage saved cannot be substantiated.
- **Every answer must stand alone when quoted.** No opening "it", "this" or "that"
  pointing back at the heading — an engine lifts one passage without its
  neighbours. This single habit is most of what gets a page quoted.
- **Short paragraphs, two or three sentences.** Long blocks do not get extracted.
- **Banned words** — they sound like something and mean nothing: control layer,
  orchestrate, leverage, seamless, empower, revolutionise, supercharge,
  next-generation, unlock, robust, cutting-edge, game-changing.
- **Answer in the first 200 words** of any section. Retrieval weights openings
  heavily; never bury the answer under context.

---

## How this gets judged

The tracker re-runs the same 20 questions and compares. The metric each item
should move:

| Item | Should move |
|---|---|
| 1. Node version | Nothing measurable — it stops broken installs |
| 2–3. Questions as headings | **Tier 1 and Tier 2 mention rate, currently 0 / 26** |
| 4. Schema | Citation rate |
| 5. Brand answers | Tier 4 stays 3/3 as more engines are added |
| 6. llms.txt | Not measured by this tracker — it targets IDE agents |

**Do items 1–3 first, then let a cycle run before starting 4–6.** Two changes at
once and neither can be attributed, which forfeits the only thing that makes this
data rather than opinion.

---

## One honest caveat

The landing page is necessary but it is not sufficient, and the same run says so.
The engines are reading **communities, not vendor sites** — this cycle they cited
code.claude.com (10), dev.to (8), github.com (7), morphllm.com (6) and arxiv.org
(5). `superterminal.dev` was cited **zero** times, and industry-wide, community
platforms take over half of all AI citations.

So finishing this list makes the site answerable and citable, which is the
prerequisite. What actually gets it cited is the same answers existing where the
engines already read: the GitHub README, a dev.to post, and Reddit threads. Those
are outside the scope of this file and outside a landing page agent's reach, but
nobody should read a completed checklist here as the job being done.
