import ora from "ora";
import pc from "picocolors";
import { indexRepo } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { generateManifest } from "../core/manifest";
import { loadConfig } from "../util/config";
import { estimateTokens, formatTokens } from "../util/tokens";
import { log } from "../util/logger";
import { printSelection, printManifestBox } from "./shared";

export async function planCommand(task: string, opts: { budget?: string; focus?: boolean }): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const budget = opts.budget ? Number(opts.budget) : config.budgetTokens;

  const spinner = ora("Indexing repo…").start();
  const index = await indexRepo(root, config);
  if (index.files.length === 0) {
    spinner.succeed("No source files yet — nothing to compress.");
    log.info("`glint run` will start in scaffold mode and build the project from scratch.");
    return;
  }

  spinner.text = "Mapping imports…";
  const graph = await buildGraph(root, index);

  spinner.text = "Selecting files…";
  const selection = await selectFiles({ task, root, index, graph, budget });
  spinner.succeed(
    `Indexed ${index.files.length} files, selected ${selection.primary.length + selection.secondary.length}`,
  );

  if (selection.primary.length === 0) {
    log.warn("Nothing matched the task terms — try more specific words (component, page, or feature names).");
    return;
  }

  printSelection(selection);

  const manifest = await generateManifest({ root, task, selection, focus: opts.focus });
  const manifestTokens = estimateTokens(manifest);
  const repoTokens = estimateTokens(index.files.reduce((sum, f) => sum + f.size, 0));

  printManifestBox({
    tokens: manifestTokens,
    budget,
    target: "dry run",
    detail: `repo is ~${formatTokens(repoTokens)} tokens — sending ${percent(manifestTokens, repoTokens)}`,
  });
  log.dim("Dry run — nothing sent. Execute with `glint run`.");
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.min(100, Math.round((part / whole) * 100))}%`;
}
