# Super Terminal — window spec for the landing page

**Purpose.** Three looping terminal windows on the landing page, each replaying a
real Super Terminal task. This document is the source of truth for how they look
and behave. Everything below was read out of the CLI source or captured from a
live run — none of it is invented.

**Non-negotiable:** the windows must look like the product, not like a marketing
mock. Every string, glyph, colour and timing here comes from the shipped CLI.
Change the placeholders (names, repos, ticket titles). Do not change the
structure, the wording of system lines, the glyphs, or the timings.

**Everything loops.** All three windows replay forever. Section 8 is the loop
spec and it is not optional.

**Source of every literal in this document**

| What | Where it comes from |
|---|---|
| Colours | `src/report/theme.ts` |
| `✔ ⚠ ✖` and dim lines | `src/util/logger.ts` |
| Both loading animations, all 24 frames, 90ms interval | `src/report/spinner.ts` — frames computed by running the real `brandSpinner` and `pixelFrame()`, not drawn by hand |
| `?` / `✔` / `❯` / `›` prompt rendering | the `prompts` npm package, as used by every command |
| Scene 1 strings | `src/commands/connect.ts`, `src/commands/provider.ts` |
| Scene 2 strings | `src/commands/ticket.ts`, `src/core/review.ts` — picker captured from a live run |
| Scene 3 strings | `src/commands/team.ts` — captured from a live run |
| Welcome panel | captured from `node dist/cli.js` at 92 columns |

---

## 1. Design tokens

### 1.1 Colour

Super Terminal repaints the terminal itself on startup using OSC escape codes —
the blue background is the product, not a page decoration.

```
background   #0040FF     — set via OSC 11
foreground   #F3F9FF     — set via OSC 10
```

Status colours come from the terminal's own ANSI palette, so the exact hex
varies per user. Use these on the web — they are chosen to sit correctly on
`#0040FF` and to read the same way the real thing reads:

| Token | Hex | Used for |
|---|---|---|
| `--st-bg` | `#0040FF` | window background |
| `--st-fg` | `#F3F9FF` | normal output |
| `--st-dim` | `#92AFFF` | dim lines (`log.dim`) — this is `--st-fg` at 60% over `--st-bg`; use the flat hex, not opacity, so it does not double-blend |
| `--st-ok` | `#4ADE80` | `✔` success |
| `--st-warn` | `#FFD24D` | `⚠` warning |
| `--st-err` | `#FF7A7A` | `✖` error |
| `--st-accent` | `#8FD8FF` | prompts only: the `?` on an open question, the `❯`, the highlighted row. **Not** the loading animations — those are `--st-fg` |

Bold (`pc.bold`) = `font-weight: 700` at `--st-fg`. Never use a colour the CLI
does not use. There is no purple, no gradient, and no glow in this product.

### 1.2 Type and metrics

```css
font-family: ui-monospace, "SF Mono", "Menlo", "DejaVu Sans Mono",
             "Cascadia Mono", monospace;
font-size:   13px;      /* 12px acceptable on mobile, never below 11px */
line-height: 1.5;       /* ≈19.5px rows */
letter-spacing: 0;      /* must be 0 — box-drawing must join seamlessly */
font-variant-ligatures: none;
```

**The window is exactly 80 columns wide.** Every line in this document was
written to fit 80. A monospace glyph at 13px is ~7.8px wide, so the text column
is ≈624px. Add 16px padding each side.

**Font coverage matters.** The window uses braille (`⠁⠂⠄⡀`), half-blocks (`▀▄█`),
rounded box-drawing (`╭─╮│╰╯`) and `✔ ⚠ ✖ ❯ › · ●`. Menlo, DejaVu Sans Mono and
Cascadia Mono all cover these. Test on Windows Chrome specifically — if any
glyph falls back to a different font the columns will not line up. If you cannot
guarantee coverage, subset and self-host DejaVu Sans Mono.

### 1.3 Wrapping

Lines longer than 80 columns **hard-wrap at the column boundary**, with no
hyphen and no continuation indent — exactly like a real terminal. Do not use
`text-overflow: ellipsis`, do not shrink the font, do not scroll horizontally.

```css
white-space: pre-wrap;
overflow-wrap: break-word;
```

---

## 2. Window chrome

The chrome is page framing, **not product UI**. Keep it quiet.

- Rounded corners, `border-radius: 10px`.
- A 32px title bar in `#0032CC` (a darker step of the brand blue), with the
  three macOS dots at 11px: `#FF5F57`, `#FEBC2E`, `#28C840`, 8px apart, 14px
  from the left.
- Centred title in `--st-dim` at 11px: the scene name — `super-t connect`,
  `super-t ticket`, `super-t team invite`.
- Body padding 16px. Fixed height, sized to the tallest frame of that scene so
  the card never resizes mid-loop (see each scene's row count). Content is
  bottom-anchored: new lines push older ones up, like a real terminal.
- Shadow: `0 18px 50px -12px rgba(0, 24, 96, .45)`.

Do **not** add: a URL bar, tabs, a sidebar, a mouse cursor, a progress bar, or
any UI element that does not exist in a terminal.

---

## 3. Primitives

Six building blocks. Every scene is made only of these.

### 3.1 The shell prompt line

```
~/acme-web % super-t connect
```

`~/acme-web ` and `% ` are the user's own shell in `--st-dim`. The typed command
is `--st-fg`. Use a neutral placeholder directory; `~/acme-web` is fine.

### 3.2 Typing

- **55ms per character**, constant. No random jitter, no easing.
- A block cursor `█` in `--st-fg` sits after the last typed character, blinking
  at **530ms on / 530ms off**. It is visible only while that line is being
  typed, and while a confirm prompt is waiting for a key.
- After the last character, **420ms** pause before the command "runs" — that is
  the beat where a real person presses Return.

### 3.3 Printed output

Printed blocks appear **instantly**, all lines at once. The CLI writes them in a
single burst and a real terminal shows them in one frame. Do not stagger, fade
in, or typewriter printed output — that reads as fake immediately.

Glyph vocabulary, verbatim from `src/util/logger.ts`:

| Prefix | Colour | Meaning |
|---|---|---|
| `✔ ` | `--st-ok` | success |
| `⚠ ` | `--st-warn` | warning |
| `✖ ` | `--st-err` | error |
| *(none)* | `--st-fg` | plain info |
| *(none)* | `--st-dim` | hint / secondary detail |

The separator `·` and the status dot `●` are used as-is. Indentation is exactly
what the scene scripts show — usually 2 or 4 spaces — and is significant.

### 3.4 The two loading animations

Super Terminal has **two**, and they are not interchangeable. Both are the same
motion — three dots riding a travelling wave, each phase-shifted by a third of a
cycle — and both run at **12 frames × 90ms = 1,080ms per cycle**, looping
seamlessly (frame 11 → frame 0 with no discontinuity).

Both are drawn in `--st-fg` (`#F3F9FF`), **not** an accent colour.

#### (a) The line spinner — short waits

One line, braille dots. Used for anything quick: loading tickets, verifying
credentials, a lookup.

```
 0  ⠄⡀⠁      6  ⠂⠁⡀
 1  ⠂⡀⠂      7  ⠄⠁⠄
 2  ⠁⡀⠄      8  ⡀⠁⠄
 3  ⠁⠄⠄      9  ⡀⠂⠂
 4  ⠁⠄⡀     10  ⡀⠄⠁
 5  ⠂⠂⡀     11  ⠄⠄⠁
```

Rendered as `{frame} {text}`:

```
⠄⡀⠁ Loading tickets from GitHub Issues, Linear…
```

Two ways it ends, both real:

- **Cleared** — the line is removed and the next output takes its place.
- **Succeeded** — replaced in place by `✔ {success label}` in `--st-ok`. The
  success label is a **different string** from the spinner label: the CLI calls
  `spinner.succeed("Credentials verified")` on a spinner that was reading
  `Verifying credentials…`. Do not just prefix the running label with a tick.

#### (b) The pixel wave — long waits, while an agent works

**Three rows tall.** The dot is `██`, the wordmark's own pixel. A full block
fills its cell, so a dot between rows is drawn as `▄▄` on the upper row and `▀▀`
on the lower — the two stack into one block straddling the boundary, which is
what gives the wave its smooth bob instead of a snap. Three rows, five positions.

This is the animation that plays while an agent is thinking. It is the
product's signature, and Scene 2 must use it.

Every row is indented **2 spaces**; the grid is 8 columns (`██ ██ ██`); the
label is dim, on the **middle row only**, 2 spaces after the grid.

All 12 frames — three strings each, top row first, every string exactly 8
characters (spaces are significant; do not trim them):

```js
const WAVE = [
  ["      ██", "██      ", "   ██   "],
  ["▄▄    ▄▄", "▀▀    ▀▀", "   ██   "],
  ["██      ", "      ██", "   ██   "],
  ["██      ", "   ▄▄ ▄▄", "   ▀▀ ▀▀"],
  ["██      ", "   ██   ", "      ██"],
  ["▄▄ ▄▄   ", "▀▀ ▀▀   ", "      ██"],
  ["   ██   ", "██      ", "      ██"],
  ["   ██   ", "▄▄    ▄▄", "▀▀    ▀▀"],
  ["   ██   ", "      ██", "██      "],
  ["   ▄▄ ▄▄", "   ▀▀ ▀▀", "██      "],
  ["      ██", "   ██   ", "██      "],
  ["      ██", "▄▄ ▄▄   ", "▀▀ ▀▀   "],
];
```

The pixel wave **always clears** — all three rows are wiped when the agent
finishes, and the output that follows takes their place. It never leaves a mark.

Set `line-height: 1` on the three wave rows so the half-blocks join vertically
with no seam. At `line-height: 1.5` you get visible gaps and the illusion breaks.

The trailing `…` on every label is a single ellipsis character, not three
periods.

### 3.5 The select prompt

From the `prompts` library. Captured from a live `super-t ticket`:

```
? Which ticket? › - Use arrow-keys. Return to submit.
❯   [GitHub Issues] #1  Login Page
    [Linear] SUP-6  Home Page
    [Linear] SUP-4  Set up your teams
```

Rules:

- Question line: `?` in `--st-accent`, then the question in `--st-fg`, then
  ` › ` in `--st-dim`, then `- Use arrow-keys. Return to submit.` in `--st-dim`.
- Highlighted row: `❯` in `--st-accent`, three spaces, then the title in
  `--st-accent` **underlined**.
- Other rows: four leading spaces, title in `--st-fg`.
- If a choice has a description, it appears after the title in `--st-dim` on the
  highlighted row only.
- **On submit the whole block collapses to one line:**
  `✔ Which ticket? › [Linear] SUP-6  Home Page`
  with `✔` in `--st-ok` and the chosen value in `--st-dim`. This collapse is
  instant. It is the single most recognisable thing about this library — get it
  right and the window reads as real.

**Arrow-key motion:** hold the initial row for **700ms**, then move one row every
**550ms**, then hold the final row **650ms** before submitting. Movement is an
instant row change — no sliding, no transition.

### 3.6 The confirm prompt

```
? Invite octocat (The Octocat)? › (y/N)
```

- `(y/N)` when the default is no, `(Y/n)` when the default is yes. Capital
  letter is the default. Both appear in the real product; use whichever the
  scene script specifies.
- The typed key appears after `›`, cursor blinking before it.
- On submit it collapses to `✔ Invite octocat (The Octocat)? › yes`.

---

## 4. Scene 1 — Connecting an AI agent

**Title bar:** `super-t connect` · **Height:** 15 rows · **Duration:** 10,165ms

The one-time setup. Shows that Super Terminal uses the subscription you already
have.

### Script

| # | Op | Content | ms |
|---|---|---|---|
| 1 | hold | empty window | 600 |
| 2 | type | `super-t connect` after the shell prompt | 825 + 420 |
| 3 | print | line A (bold), blank, notice ×2 (dim), blank | 0 |
| 4 | hold | | 900 |
| 5 | select | 4 choices, start row 0, move to row 2 | 700 + 550×2 + 650 |
| 6 | spinner | `Verifying credentials…` → succeeds as `✔ Credentials verified` (different text) | 1,980 |
| 7 | print | `✔ Using Claude Code — via your \`claude\` login.` | 0 |
| 8 | hold | end frame | 2,400 |

### Exact text

Shell line:
```
~/acme-web % super-t connect
```

Step 3, printed as one block (line 1 bold, lines 3–4 dim):
```
Connect Super Terminal to your AI — one-time setup.

Super Terminal counts anonymous usage (which agent, whether a task finished) to see what's working.
Never your prompts, filenames, or code. Turn it off: super-t telemetry off

```
> Those two dim lines are the real first-run telemetry notice, verbatim. They
> are long and will wrap at 80 columns — that is correct and it is worth showing.
> This is a privacy disclosure appearing before anything is recorded, and it is
> one of the more persuasive things on the page.

Step 5, the select. Choices are the real ones, in this order:
```
? How do you want to connect? › - Use arrow-keys. Return to submit.
    Anthropic API key
    Browser login (Anthropic CLI)
❯   Claude Code
    Cursor — not installed yet
    ChatGPT (Codex)
```
Highlight starts on `Anthropic API key` (row 0) and steps down to `Claude Code`
(row 2). While `Claude Code` is highlighted, its description shows dim after the
title — this is the line that says the product bills nothing of its own:
```
❯   Claude Code   covered by your Claude Code login/subscription; via `claude`
```
The other two agents' descriptions, if you highlight them instead, are
`covered by your Cursor subscription` and `covered by your ChatGPT plan`.

Collapsed on submit:
```
✔ How do you want to connect? › Claude Code
```

Step 6 spinner, then step 7:
```
⠄⡀⠁ Verifying credentials…
```
becomes
```
✔ Credentials verified
```
then:
```
✔ Using Claude Code — via your `claude` login.
```

### End frame

```
~/acme-web % super-t connect
Connect Super Terminal to your AI — one-time setup.

Super Terminal counts anonymous usage (which agent, whether a task finished) to
see what's working.
Never your prompts, filenames, or code. Turn it off: super-t telemetry off

✔ How do you want to connect? › Claude Code
✔ Credentials verified
✔ Using Claude Code — via your `claude` login.
```

---

## 5. Scene 2 — Taking a ticket from GitHub or Linear

**Title bar:** `super-t ticket` · **Height:** 22 rows · **Duration:** 14,340ms

The strongest scene. It shows the whole loop: real tickets from two trackers in
one list, the work, then a *different vendor's* AI checking each requirement.

### Script

| # | Op | Content | ms |
|---|---|---|---|
| 1 | hold | empty window | 600 |
| 2 | type | `super-t ticket` | 770 + 420 |
| 3 | spinner | `Loading tickets from GitHub Issues, Linear…` → **cleared** | 1,980 |
| 4 | print | count line | 0 |
| 5 | select | 3 choices, start row 0, move to row 1 | 700 + 550 + 650 |
| 6 | print | blank, ticket header, dim detail | 0 |
| 7 | hold | | 700 |
| 8 | **pixel wave** | `Claude Code is thinking…` → **cleared** | 3,240 |
| 9 | print | blank, changed-files count, blank, agent summary, blank, dim undo line | 0 |
| 10 | hold | | 900 |
| 11 | print | second-opinion rule, criteria block, verdict | 0 |
| 12 | hold | end frame | 3,000 |

### Exact text

```
~/acme-web % super-t ticket
```

Step 3 spinner — the label lists every connected tracker, comma-separated. This
is the point of the scene: one list, every tracker.
```
⠄⡀⠁ Loading tickets from GitHub Issues, Linear…
```

Step 4, captured verbatim from a live run:
```
3 ticket(s) assigned to you — 1 from GitHub Issues, 2 from Linear.
```

Step 5, the picker, captured verbatim (placeholders swapped):
```
? Which ticket? › - Use arrow-keys. Return to submit.
❯   [GitHub Issues] #1  Login Page
    [Linear] SUP-6  Home Page
    [Linear] SUP-4  Set up your teams
```
Move the highlight from row 0 to row 1, then submit:
```
✔ Which ticket? › [Linear] SUP-6  Home Page
```

Step 6 — blank line first, then the ref bold and the title plain, then a dim
detail line:
```

SUP-6 — Home Page
  Linear · 2 acceptance criteria found
```

Step 8 — the **pixel wave**, not the line spinner. Three rows, 2-space indent,
label dim on the middle row, exactly 3 cycles (3,240ms), then all three rows are
wiped:
```
  ▄▄    ▄▄
  ▀▀    ▀▀  Claude Code is thinking…
     ██
```

Step 9 — `+48` is `--st-ok`, and `−12` uses the **minus sign `−` (U+2212)**, not
a hyphen, in `--st-err`. The last line is dim:
```

3 file(s) changed, +48 −12

Added a PayPal option beside the card form and wired the empty-state branch.

Undo anytime with `super-t revert`.
```

Step 11 — the second-opinion block. The rule is a dim line padded with `─` to a
fixed width, then the per-criterion verdicts:
```

── Second opinion · ChatGPT (Codex) reviewing ─────────
  Acceptance criteria — 1 of 2 met
    ✓ 1. Hero section renders on mobile at 375px
    ✗ 2. Empty state shows a message — no empty branch found
⚠ Second opinion (ChatGPT (Codex)) raised 1 issue(s):
    · home.tsx: nothing rendered when the list is empty
  Advisory only — undo everything with `super-t revert` if you agree.
```

Colour rules for that block:
- The `──` rule line: entirely `--st-dim`.
- `Acceptance criteria — 1 of 2 met`: **bold**, `--st-fg`.
- A met criterion (`✓`): `--st-fg`.
- An unmet criterion (`✗`) and its ` — reason` tail: the **whole line**
  `--st-warn`. This is `log.info(pc.yellow(line))` — not just the mark.
- `⚠ Second opinion …`: `--st-warn`.
- The `· …` note lines: `--st-fg`, four-space indent.
- The `Advisory only …` line: `--st-dim`.

> Do not "fix" the double parentheses in `Second opinion (ChatGPT (Codex))`. The
> agent's own title contains brackets and that is what ships.
>
> Show **1 of 2**, never 2 of 2. A tool that always passes is a tool nobody
> believes. The reviewer catching something real is the whole argument.

---

## 6. Scene 3 — Inviting a team member

**Title bar:** `super-t team invite` · **Height:** 13 rows · **Duration:** 11,735ms

Shows the safety step: the invite resolves the username to a real person and
names the access being granted **before** anything is confirmed.

### Script

| # | Op | Content | ms |
|---|---|---|---|
| 1 | hold | empty window | 600 |
| 2 | type | `super-t team invite octocat` (27 chars) | 1,485 + 420 |
| 3 | spinner | *(no label — the GitHub lookup)* | 900 |
| 4 | print | blank, person block, blank | 0 |
| 5 | hold | | 500 |
| 6 | print | the ⚠ access warning | 0 |
| 7 | hold | | 1,100 |
| 8 | confirm | `Invite octocat (The Octocat)?` default **N**, answer `y` | 1,600 |
| 9 | spinner | `Sending the invitation…` → **cleared** | 1,620 |
| 10 | print | ✔ line + two dim follow-ups | 0 |
| 11 | hold | end frame | 2,800 |

### Exact text

```
~/acme-web % super-t team invite octocat
```

Steps 4 and 6, captured verbatim from a live run (repo name is the placeholder):
```

  octocat — The Octocat
  https://github.com/octocat

⚠ This gives that person push access to acme/web. Make sure it is who you mean.
```
`octocat` is **bold**; ` — The Octocat` is plain `--st-fg`; the URL line is dim.

Step 8, the confirm. Default is **N** — the safe default, and showing it is the
point:
```
? Invite octocat (The Octocat)? › (y/N)
```
Wait 900ms with the cursor blinking, type `y` (55ms), wait 645ms, then collapse:
```
✔ Invite octocat (The Octocat)? › yes
```

Step 10:
```
✔ octocat added to the team and invited to the repository.
  Commit .super-t/team.json so the rest of the team sees them too.
  They run: npm i -g super-t && super-t team status
```
First line `--st-ok`, the two following lines `--st-dim`.

### End frame

```
~/acme-web % super-t team invite octocat

  octocat — The Octocat
  https://github.com/octocat

⚠ This gives that person push access to acme/web. Make sure it is who you mean.
✔ Invite octocat (The Octocat)? › yes
✔ octocat added to the team and invited to the repository.
  Commit .super-t/team.json so the rest of the team sees them too.
  They run: npm i -g super-t && super-t team status
```

---

## 7. Optional: the welcome panel

Captured verbatim from a real run. Use it as a hero visual if you want one still
image with no motion. It is **74 columns** wide, so it fits inside the 80-column
window. Do not retype it — copy it.

```
╭─ Super Terminal · v2.1.0 ──────────────────────────────────────────────╮
│                               │                                        │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ What is Super Terminal?                │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ Super Terminal is the control layer    │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ for AI coding agents. Your rules,      │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ context, and skills apply to Claude    │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ Code, Cursor, and Codex alike — and    │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ several agents can be chained into one │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ workflow. Every change is reviewed and │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │ reversible.                            │
│      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │                                        │
│                               │ Getting started                        │
│        Super Terminal         │ super-t run "task"  start a session    │
│                               │ super-t switch  change agent           │
│        Welcome, Waqas!        │ super-t search  switch project         │
│                               │ super-t plan "task"  preview (free)    │
│ ● connected · ChatGPT (Codex) │                                        │
│ ~/Desktop/Squash              │                                        │
╰────────────────────────────────────────────────────────────────────────╯
```

Replace `Welcome, Waqas!` and `~/Desktop/Squash` with placeholders. The `●` is
`--st-ok`. The `▀` block is the logo mark — it must render as a solid rectangle
with no gaps between rows; if you see horizontal gaps, `line-height` is too
loose for that element, so set `line-height: 1` on the logo lines only.

The version string must match whatever npm actually serves on launch day.

---

## 8. The loop

All three windows replay continuously.

### 8.1 Timeline model — do not use chained timeouts

Build each scene as a flat list of operations with **absolute start times in
milliseconds**, then render on `requestAnimationFrame` from a single clock:

```
t = (performance.now() - startedAt + staggerOffset) % sceneDuration
```

Every operation renders deterministically from `t`. A chained `setTimeout`
implementation drifts, desynchronises when the tab is backgrounded, and can
strand a scene mid-typing. The modulo approach cannot: the loop point is exact,
recovery from a backgrounded tab is automatic, and every replay is identical.

### 8.2 Loop point and reset

- The last operation of every scene is a **hold on the end frame**. Durations
  above already include it: 2,400ms (Scene 1), 3,000ms (Scene 2), 2,800ms
  (Scene 3). Scene 2 holds longest because it has the most to read.
- After the hold, **fade the body out over 350ms** (`opacity` only), then start
  the next cycle from an empty window. Each scene's script opens with a 600ms
  hold on empty, which covers the fade-in.
- Never hard-cut from a full window to an empty one. The flash is the one thing
  that makes a looping terminal look broken.
- Reset must be total: no leftover lines, no stuck cursor, no spinner frame
  carried over. Rendering purely from `t` gives you this for free.

### 8.3 Stagger

Do not let three windows restart in unison — it draws the eye to the loop
instead of the content. Give each a fixed starting offset:

| Scene | Offset |
|---|---|
| 1 — Connect | 0ms |
| 2 — Ticket | 2,600ms |
| 3 — Invite | 5,200ms |

Offsets are constants, not random. The page must look identical on every load.

### 8.4 Pause when not visible

Wrap each window in an `IntersectionObserver` at `threshold: 0.15`. When a
window leaves the viewport, stop its `requestAnimationFrame` loop. When it comes
back, resume **from where it stopped** — advance `startedAt` by the paused
duration rather than restarting the scene. A visitor scrolling back up should
not see the scene jump.

Also stop on `document.visibilitychange` when the tab is hidden.

Three rAF loops on one page is fine. Three that keep running off-screen is a
laptop fan spinning up on a landing page.

### 8.5 Reduced motion

```css
@media (prefers-reduced-motion: reduce) { /* no animation at all */ }
```

Render the **end frame** of each scene, statically, and never start the clock.
The end frames are printed in full in sections 4, 5 and 6 — they stand on their
own and are arguably the better read. Do not offer a play button; do not use a
slowed-down animation as a compromise.

---

## 9. Reference implementation

Drop-in and self-contained. Copy it or reimplement it, but match its behaviour.

This code was **built and run end-to-end** against all three scenes before it
was written down. Verified: every scene renders empty at `t=0` so each replay
starts clean; scene totals are 10,165ms / 14,340ms / 11,735ms; the tallest
frames are 12 / 20 / 10 rows, inside the heights given in sections 4–6; and only
one line in the whole set exceeds 80 columns — the telemetry notice in Scene 1,
which wraps on purpose.

```html
<div class="st-win" data-scene="ticket" data-offset="2600">
  <div class="st-bar"><i></i><i></i><i></i><span>super-t ticket</span></div>
  <pre class="st-body" aria-live="off"><div class="st-lines"></div></pre>
</div>
```

> **The inner `.st-lines` div is required, not cosmetic.** The body is a column
> flexbox so the content can sit bottom-anchored like a real terminal — but a
> column flexbox turns *every inline child and text run into its own flex item*,
> which shatters each output line into several. Put all the text inside one
> block child and set `innerHTML` on that. Getting this wrong is the single most
> likely way to end up with a window that looks almost right and reads wrong.

```css
.st-win{--st-bg:#0040FF;--st-fg:#F3F9FF;--st-dim:#92AFFF;--st-ok:#4ADE80;
  --st-warn:#FFD24D;--st-err:#FF7A7A;--st-accent:#8FD8FF;
  background:var(--st-bg);border-radius:10px;overflow:hidden;
  box-shadow:0 18px 50px -12px rgba(0,24,96,.45)}
.st-bar{height:32px;background:#0032CC;display:flex;align-items:center;
  gap:8px;padding:0 14px;position:relative}
.st-bar i{width:11px;height:11px;border-radius:50%;flex:none}
.st-bar i:nth-child(1){background:#FF5F57}
.st-bar i:nth-child(2){background:#FEBC2E}
.st-bar i:nth-child(3){background:#28C840}
.st-bar span{position:absolute;inset:0;display:grid;place-items:center;
  font:11px ui-monospace,Menlo,monospace;color:var(--st-dim);pointer-events:none}
.st-body{margin:0;padding:16px;min-height:20rem;
  display:flex;flex-direction:column;justify-content:flex-end;
  font:13px/1.5 ui-monospace,"SF Mono",Menlo,"DejaVu Sans Mono",monospace;
  letter-spacing:0;font-variant-ligatures:none;color:var(--st-fg);
  transition:opacity .35s linear}
/* all text lives in ONE flex item — see the note above */
.st-lines{white-space:pre-wrap;overflow-wrap:break-word}
.st-body.st-out{opacity:0}
.st-lines b{font-weight:700}
.st-dim{color:var(--st-dim)} .st-ok{color:var(--st-ok)}
.st-warn{color:var(--st-warn)} .st-err{color:var(--st-err)}
.st-acc{color:var(--st-accent)} .st-sel{color:var(--st-accent);text-decoration:underline}
.st-wave{line-height:1}   /* half-blocks must join with no seam */
.st-cur{animation:st-blink 1.06s steps(1,end) infinite}
@keyframes st-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.st-cur{animation:none;opacity:0}}
```

```js
const FRAMES = ["⠄⡀⠁","⠂⡀⠂","⠁⡀⠄","⠁⠄⠄","⠁⠄⡀","⠂⠂⡀",
                "⠂⠁⡀","⠄⠁⠄","⡀⠁⠄","⡀⠂⠂","⡀⠄⠁","⠄⠄⠁"];
const WAVE = [
  ["      ██","██      ","   ██   "], ["▄▄    ▄▄","▀▀    ▀▀","   ██   "],
  ["██      ","      ██","   ██   "], ["██      ","   ▄▄ ▄▄","   ▀▀ ▀▀"],
  ["██      ","   ██   ","      ██"], ["▄▄ ▄▄   ","▀▀ ▀▀   ","      ██"],
  ["   ██   ","██      ","      ██"], ["   ██   ","▄▄    ▄▄","▀▀    ▀▀"],
  ["   ██   ","      ██","██      "], ["   ▄▄ ▄▄","   ▀▀ ▀▀","██      "],
  ["      ██","   ██   ","██      "], ["      ██","▄▄ ▄▄   ","▀▀ ▀▀   "],
];
const CHAR_MS = 55, ENTER_MS = 420, FRAME_MS = 90, FADE_MS = 350;
const PROMPT  = "~/acme-web % ";
const esc = s => s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

// ── Ops ─────────────────────────────────────────────────────────────────
// hold {ms}                          empty beat
// cmd  {text}                        types after the shell prompt
// out  {lines:[[text,cls]]}          prints instantly, stays forever
// spin {text, ms, ok?}               braille spinner; `ok` is the SUCCESS label
//                                    it collapses to, and differs from `text`
// wave {text, ms}                    three-row pixel wave; always clears
// sel  {q, rows:[[title,desc]], from, to, done}
// ask  {q, hint, done}

// A switch, not an object literal — an object literal evaluates every branch,
// so `op.text.length` would throw on a `hold` op that has no text.
const dur = op => {
  switch (op.k){
    case "cmd": return op.text.length * CHAR_MS + ENTER_MS;
    case "out": return 120;
    case "sel": return 700 + Math.abs(op.to - op.from) * 550 + 650;
    case "ask": return 1600;
    default:    return op.ms;            // hold, spin, wave
  }
};

function timeline(ops){
  let t = 0;
  const tl = ops.map(op => { const e = {...op, at: t, d: dur(op)}; t += e.d; return e; });
  return { tl, total: t + FADE_MS };
}

function render(t, tl){
  const L = [], push = (s, c) => L.push(c ? `<span class="${c}">${s}</span>` : s);
  const cursor = '<span class="st-cur">█</span>';
  for (const op of tl){
    if (t < op.at) break;
    const l = t - op.at, live = l < op.d;
    if (op.k === "cmd"){
      const n = Math.min(op.text.length, Math.floor(l / CHAR_MS));
      push(`<span class="st-dim">${esc(PROMPT)}</span>${esc(op.text.slice(0,n))}` +
           (live ? cursor : ""));
    } else if (op.k === "out"){
      for (const [text, cls] of op.lines) push(esc(text), cls);
    } else if (op.k === "spin"){
      // the spinner is brand-light #F3F9FF — the default fg, not an accent
      if (live) push(`${FRAMES[Math.floor(l / FRAME_MS) % 12]} ${esc(op.text)}`);
      else if (op.ok) push(`✔ ${esc(op.ok)}`, "st-ok");   // ok = success label
    } else if (op.k === "wave"){
      if (live){                                   // 3 rows; label dim on row 1
        const g = WAVE[Math.floor(l / FRAME_MS) % 12];
        g.forEach((row, r) => push(`<span class="st-wave">  ${row}` +
          (r === 1 ? `  <span class="st-dim">${esc(op.text)}</span>` : "") +
          `</span>`));
      }                                            // else: wiped, nothing stays
    } else if (op.k === "sel"){
      if (live){
        const step = Math.max(0, Math.floor((l - 700) / 550));
        const dir  = Math.sign(op.to - op.from);
        const i    = op.from + dir * Math.min(step, Math.abs(op.to - op.from));
        push(`<span class="st-acc">?</span> ${esc(op.q)}` +
             `<span class="st-dim"> › - Use arrow-keys. Return to submit.</span>`);
        op.rows.forEach(([title, desc], r) => {
          if (r === i) push(`<span class="st-acc">❯</span>   ` +
            `<span class="st-sel">${esc(title)}</span>` +
            (desc ? `<span class="st-dim">   ${esc(desc)}</span>` : ""));
          else push(`    ${esc(title)}`);
        });
      } else {
        push(`<span class="st-ok">✔</span> ${esc(op.q)}` +
             `<span class="st-dim"> › ${esc(op.done)}</span>`);
      }
    } else if (op.k === "ask"){
      if (live){
        const typed = l > 900 ? "y" : "";
        push(`<span class="st-acc">?</span> ${esc(op.q)}` +
             `<span class="st-dim"> › ${esc(op.hint)} </span>` +
             (typed ? esc(typed) : cursor));
      } else {
        push(`<span class="st-ok">✔</span> ${esc(op.q)}` +
             `<span class="st-dim"> › ${esc(op.done)}</span>`);
      }
    }
  }
  return L.join("\n");
}

function mount(el, ops, offset){
  const { tl, total } = timeline(ops);
  const body  = el.querySelector(".st-body");
  const lines = el.querySelector(".st-lines");   // the single flex item
  let started = performance.now() - offset, raf = 0, running = false;

  const tick = now => {
    const t = (now - started) % total;
    lines.innerHTML = render(t, tl);
    body.classList.toggle("st-out", t > total - FADE_MS);
    raf = requestAnimationFrame(tick);
  };
  const start = () => { if (running) return; running = true;
    raf = requestAnimationFrame(tick); };
  const stop  = () => { if (!running) return; running = false;
    cancelAnimationFrame(raf); pausedAt = performance.now(); };

  let pausedAt = 0;
  const resume = () => { if (pausedAt) started += performance.now() - pausedAt;
    pausedAt = 0; start(); };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches){
    const last = tl[tl.length - 1];
    lines.innerHTML = render(last.at + last.d - 1, tl);
    return;                                     // static end frame, no clock
  }
  new IntersectionObserver(([e]) => e.isIntersecting ? resume() : stop(),
    { threshold: .15 }).observe(el);
  document.addEventListener("visibilitychange",
    () => document.hidden ? stop() : resume());
}
```

Scene 3 as a worked example of the op format:

```js
const inviteScene = [
  { k:"hold", ms:600 },
  { k:"cmd",  text:"super-t team invite octocat" },
  { k:"spin", text:"", ms:900 },
  { k:"out",  lines:[
      ["", null],
      ["  octocat — The Octocat", null],
      ["  https://github.com/octocat", "st-dim"],
      ["", null],
  ]},
  { k:"hold", ms:500 },
  { k:"out",  lines:[["⚠ This gives that person push access to acme/web. " +
                      "Make sure it is who you mean.", "st-warn"]] },
  { k:"hold", ms:1100 },
  { k:"ask",  q:"Invite octocat (The Octocat)?", hint:"(y/N)", done:"yes" },
  { k:"spin", text:"Sending the invitation…", ms:1620 },
  { k:"out",  lines:[
      ["✔ octocat added to the team and invited to the repository.", "st-ok"],
      ["  Commit .super-t/team.json so the rest of the team sees them too.", "st-dim"],
      ["  They run: npm i -g super-t && super-t team status", "st-dim"],
  ]},
  { k:"hold", ms:2800 },
];
mount(document.querySelector('[data-scene="invite"]'), inviteScene, 5200);
```

`octocat` needs `<b>` around it in the person line — wrap it when you build the
real scene data, or split it into two spans.

---

## 10. Rules

**Must:**

- Real text in the DOM. Never a screenshot, never a video, never canvas. The
  output must be selectable, copyable and indexable — half the value of showing
  a terminal is that a developer can select the command.
- Placeholders only for names, repos, directories and ticket titles. Every
  system-generated string stays exactly as written here.
- The window is decorative; give the wrapper `aria-hidden="true"` and put the
  same content in a visually-hidden `<pre>`, or keep `aria-live="off"` so a
  screen reader never announces the animation frame by frame.
- Stack the three windows vertically below 900px. Do not shrink below 11px and
  do not reduce the column count — the box-drawing and the wrapped lines are
  authored for 80.

**Must not:**

- No invented commands, flags, or output. Everything on screen must be something
  the shipped CLI actually prints.
- No numbers that are not on screen in a real run — no percentages, no time
  saved, no token counts. The product deliberately does not display token or
  cost figures.
- No "2 of 2 met". The reviewer must be shown catching something.
- No sound, no confetti, no typing sound effects, no scanlines, no CRT curve, no
  glow, no gradient background. The blue is flat `#0040FF`.
- No mouse cursor, no click ripples, no hover states inside the window.

**If you change one thing, change the placeholders.** If you change two, you are
probably making it look less like the product.
