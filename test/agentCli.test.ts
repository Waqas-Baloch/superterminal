import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  AGENT_CLIS,
  runAgent,
  composeArgs,
  parseAgentEvent,
  type AgentCliDef,
  isGitRepo,
  hasHeadCommit,
  gitInit,
  gitBaselineCommit,
  gitDirtyFiles,
  gitBefore,
} from "../src/claude/agentCli";

let dir: string;

describe("agent CLI registry", () => {
  it("composes headless args for each agent", () => {
    expect(AGENT_CLIS["claude-code"].runArgs("do x")).toEqual(["-p", "do x", "--permission-mode", "acceptEdits"]);
    expect(AGENT_CLIS.cursor.runArgs("do x")).toEqual(["-p", "do x", "--force"]);
    expect(AGENT_CLIS.codex.runArgs("do x")).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "do x",
    ]);
  });

  it("continuation keeps the repair prompt intact", () => {
    for (const agent of Object.values(AGENT_CLIS)) {
      const args = agent.continueArgs("fix the tsc errors");
      expect(args.join(" ")).toContain("fix the tsc errors");
    }
  });
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-git-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-qm", "init"], { cwd: dir });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("git helpers", () => {
  it("detects a git repo (and a non-repo)", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    expect(await isGitRepo(os.tmpdir())).toBe(false);
  });

  it("reports modified and untracked files after a change", async () => {
    expect((await gitDirtyFiles(dir)).size).toBe(0);
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(dir, "new.ts"), "export const fresh = 1;\n");
    const dirty = await gitDirtyFiles(dir);
    expect(dirty.has("a.ts")).toBe(true);
    expect(dirty.has("new.ts")).toBe(true);
  });

  it("returns HEAD content for tracked files and null for new files", async () => {
    expect(await gitBefore(dir, "a.ts")).toBe("export const a = 1;\n");
    expect(await gitBefore(dir, "new.ts")).toBeNull();
  });

  it("bootstraps a fresh repo with a baseline commit", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "st-fresh-"));
    await fs.writeFile(path.join(fresh, "style.css"), "body { margin: 0; }\n");

    expect(await isGitRepo(fresh)).toBe(false);
    await gitInit(fresh);
    expect(await isGitRepo(fresh)).toBe(true);
    expect(await hasHeadCommit(fresh)).toBe(false);

    await gitBaselineCommit(fresh);
    expect(await hasHeadCommit(fresh)).toBe(true);
    expect(await gitBefore(fresh, "style.css")).toBe("body { margin: 0; }\n");

    await fs.rm(fresh, { recursive: true, force: true });
  });
});

describe("parseAgentEvent — one parser, every agent's JSON shape", () => {
  const j = (o: unknown) => JSON.stringify(o);

  it("Claude/Cursor stream-json: tool_use → step, text → narration, result → usage", () => {
    expect(parseAgentEvent(j({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))).toEqual({ text: "hi" });
    expect(
      parseAgentEvent(j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }] } })),
    ).toEqual({ step: "→ Writing src/a.ts" });
    expect(
      parseAgentEvent(j({ type: "result", total_cost_usd: 0.02, usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 250 } })),
    ).toEqual({ usage: { inputTokens: 1000, outputTokens: 250, costUsd: 0.02 } });
  });

  it("Codex JSONL: exec/patch/token events map to steps and usage", () => {
    expect(parseAgentEvent(j({ id: "1", msg: { type: "exec_command_begin", command: ["npm", "test"] } }))).toEqual({
      step: "→ Running npm test",
    });
    expect(
      parseAgentEvent(j({ id: "2", msg: { type: "patch_apply_begin", changes: { "src/app.ts": {}, "src/b.ts": {} } } })),
    ).toMatchObject({ step: "→ Editing src/app.ts (+1 more)" });
    expect(parseAgentEvent(j({ msg: { type: "token_count", input_tokens: 500, output_tokens: 80 } }))).toEqual({
      usage: { inputTokens: 500, outputTokens: 80, costUsd: undefined },
    });
    expect(parseAgentEvent(j({ msg: { type: "agent_message", message: "thinking…" } }))).toEqual({ text: "thinking…" });
  });

  // These are verbatim events from a real `codex exec --json` run. The parser
  // was written against an assumed schema that didn't match — a file edit
  // rendered as "→ Editing 0" because item.changes is an array, not an object.
  it("Codex real schema (item.*/turn.completed): captured from the live CLI", () => {
    const fileChange = {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "/repo/index.html", kind: "update" }],
        status: "completed",
      },
    };
    expect(parseAgentEvent(j(fileChange))).toMatchObject({ step: "→ Editing /repo/index.html" });

    const twoFiles = {
      type: "item.started",
      item: {
        type: "file_change",
        changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }],
      },
    };
    expect(parseAgentEvent(j(twoFiles))).toMatchObject({ step: "→ Editing a.ts (+1 more)" });

    // Commands come wrapped as `/bin/zsh -lc "…"`; show the real command.
    const command = {
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: `/bin/zsh -lc "rg -n '<h1' index.html"`, status: "in_progress" },
    };
    expect(parseAgentEvent(j(command))).toEqual({ step: "→ Running rg -n '<h1' index.html" });

    const turnDone = {
      type: "turn.completed",
      usage: { input_tokens: 39800, cached_input_tokens: 36096, output_tokens: 288, reasoning_output_tokens: 14 },
    };
    expect(parseAgentEvent(j(turnDone))).toMatchObject({ usage: { inputTokens: 39800, outputTokens: 288 } });

    const agentMessage = { type: "item.completed", item: { type: "agent_message", text: "Updated index.html." } };
    expect(parseAgentEvent(j(agentMessage))).toEqual({ text: "Updated index.html." });
  });

  it("unknown JSON returns null (so the run degrades to the wave, never a blank)", () => {
    expect(parseAgentEvent(j({ msg: { type: "some_future_event", detail: 42 } }))).toBeNull();
    expect(parseAgentEvent("not json at all")).toBeNull();
  });
});

describe("composeArgs — surgical mode restrictions (Step 0)", () => {
  const base = ["-p", "do the task", "--permission-mode", "acceptEdits"];

  it("appends JSON-usage flags but no restrictions in normal mode", () => {
    const args = composeArgs(AGENT_CLIS["claude-code"], base, false);
    expect(args).toContain("--output-format");
    expect(args).not.toContain("--disallowedTools");
  });

  it("cuts exploration tools in surgical mode, keeping Read/Edit (they aren't disallowed)", () => {
    const args = composeArgs(AGENT_CLIS["claude-code"], base, true);
    expect(args).toContain("--disallowedTools");
    for (const t of ["Bash", "Grep", "Glob"]) expect(args).toContain(t);
    // Read/Edit/Write must NOT be disallowed — the edit still has to apply.
    for (const t of ["Read", "Edit", "Write"]) expect(args).not.toContain(t);
    // Restrictions come last so the variadic flag doesn't swallow others.
    expect(args.indexOf("--disallowedTools")).toBeGreaterThan(args.indexOf("--output-format"));
  });
});

describe("live output relay", () => {
  // Piping (instead of inheriting) the agent's stdio is what lets Super Terminal show a
  // spinner over the dead air and clear it the moment the agent speaks — but
  // piping is also what once made Codex hang with no output. This pins the
  // contract: output must stream through live, and the first byte must be
  // signalled while the agent is still running.
  const script = `
    setTimeout(() => {
      process.stdout.write("CHUNK-1\\n");
      setTimeout(() => process.stdout.write("CHUNK-2\\n"), 150);
      setTimeout(() => process.stdout.write("CHUNK-3\\n"), 300);
    }, 300);
  `;
  // Plain-text agent (no jsonUsage) — forwards bytes as-is.
  const fake: AgentCliDef = { ...AGENT_CLIS["claude-code"], bin: "node", jsonUsage: undefined, runArgs: () => ["-e", script] };

  it("streams output live and signals the first byte mid-run", async () => {
    const start = Date.now();
    let firstOutputAt = -1;
    const seen: number[] = [];

    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (String(chunk).includes("CHUNK-")) seen.push(Date.now() - start);
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    try {
      await runAgent(fake, process.cwd(), "ignored", () => {
        firstOutputAt = Date.now() - start;
      });
    } finally {
      (process.stdout as unknown as { write: unknown }).write = write;
    }

    const total = Date.now() - start;
    // Fired while the agent was still running — that's the gap the wave covers.
    expect(firstOutputAt).toBeGreaterThanOrEqual(250);
    expect(firstOutputAt).toBeLessThan(total - 200);
    // Streamed through rather than dumped at exit.
    expect(seen).toHaveLength(3);
    expect(seen[2] - seen[0]).toBeGreaterThan(200);
  });

  it("parses Claude Code stream-json: shows steps, suppresses code narration, captures real usage", async () => {
    // A fake agent that emits Claude-Code-shaped stream-json events, then a
    // `result` event carrying the true token usage + cost.
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Editing the navbar." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/Nav.tsx" } }] } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.0123,
        usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 250 },
      }),
    ];
    const script = `${JSON.stringify(events)}.forEach(l => process.stdout.write(l + "\\n"));`;
    const jsonAgent: AgentCliDef = {
      ...AGENT_CLIS["claude-code"],
      bin: "node",
      // strip the real --output-format flags; our fake ignores them but they'd confuse node
      jsonUsage: { ...AGENT_CLIS["claude-code"].jsonUsage!, args: [] },
      runArgs: () => ["-e", script],
    };

    let printed = "";
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      printed += String(chunk);
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    let usage;
    try {
      usage = (await runAgent(jsonAgent, process.cwd(), "ignored")).usage;
    } finally {
      (process.stdout as unknown as { write: unknown }).write = write;
    }

    expect(printed).toContain("src/Nav.tsx"); // the step (current action) is shown
    expect(printed).toContain("Editing"); // present-continuous verb for the Edit tool
    expect(printed).not.toContain("navbar"); // narration/code suppressed during the run
    expect(printed).not.toContain('"type":"result"'); // raw JSON not leaked to the user
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 250, costUsd: 0.0123 }); // real numbers captured
  });
});
