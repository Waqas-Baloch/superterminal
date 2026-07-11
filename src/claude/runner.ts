import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompts";
import { EditStage, TOOL_DEFS, executeTool } from "./tools";
import type { RepoIndex } from "../core/indexer";

export interface RunnerUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface RunnerOptions {
  model: string;
  stage: EditStage;
  index: RepoIndex;
  apiKey?: string; // omitted → SDK default chain (env vars, ant profile)
  onProgress?: (text: string) => void;
}

const MAX_TOOL_TURNS = 40;
const MAX_TOKENS = 16_000;

/**
 * Manual agentic loop: we own the message history so validation feedback can
 * continue the same conversation (and reuse its prompt cache).
 */
export class ClaudeRunner {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  readonly usage: RunnerUsage = { input: 0, output: 0, cacheRead: 0 };

  constructor(private opts: RunnerOptions) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  /** Start the conversation with the manifest; resolves with Claude's final summary text. */
  async run(manifest: string): Promise<string> {
    this.messages.push({ role: "user", content: manifest });
    return this.loop();
  }

  /** Feed validation failures back into the same conversation. */
  async continueWith(feedback: string): Promise<string> {
    this.messages.push({ role: "user", content: feedback });
    return this.loop();
  }

  private async loop(): Promise<string> {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const response = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        cache_control: { type: "ephemeral" }, // auto-cache the growing prefix each turn
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages: this.messages,
      });

      this.usage.input += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
      this.usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      this.usage.output += response.usage.output_tokens;

      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue;

      if (response.stop_reason === "tool_use") {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const inputPath = (block.input as Record<string, unknown>)?.path;
          this.opts.onProgress?.(`${block.name}${typeof inputPath === "string" ? ` ${inputPath}` : ""}`);
          const result = await executeTool(this.opts.stage, this.opts.index, block.name, block.input);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.text,
            is_error: result.isError,
          });
        }
        this.messages.push({ role: "user", content: results });
        continue;
      }

      if (response.stop_reason === "refusal") {
        throw new Error("Claude declined this request (safety refusal). Rephrase the task and retry.");
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error("Response hit the output token cap mid-edit. Re-run with a narrower task.");
      }

      // end_turn — return the final text as the summary
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    throw new Error(`Stopped after ${MAX_TOOL_TURNS} tool turns without finishing — task may be too broad.`);
  }
}
