import { promises as fs } from "node:fs";
import { spin } from "../report/spinner";
import nodePath from "node:path";
import pc from "picocolors";
import { indexRepo } from "../core/indexer";
import { buildGraph } from "../core/mapper";
import { selectFiles } from "../core/selector";
import { generateManifest } from "../core/manifest";
import { loadConfig } from "../util/config";
import { estimateTokens, formatTokens } from "../util/tokens";
import { log } from "../util/logger";
import { printSelection, printManifestBox } from "./shared";

interface PlanOptions {
  budget?: string;
  focus?: boolean;
  show?: boolean; // print the full manifest markdown
  out?: string; // write the manifest to a file
}

export async function planCommand(task: string, opts: PlanOptions): Promise<void> {
  const root = process.cwd();
  const config = await loadConfig(root);
  const budget = opts.budget ? Number(opts.budget) : config.budgetTokens;

  const spinner = spin("Indexing repo…").start();
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
  const selectedCount = selection.primary.length + selection.supporting.length + selection.optional.length;
  spinner.succeed(`Indexed ${index.files.length} files, selected ${selectedCount}`);

  if (selectedCount === 0) {
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

  if (opts.out) {
    const outPath = nodePath.resolve(root, opts.out);
    await fs.writeFile(outPath, manifest);
    log.success(`Manifest written to ${opts.out}`);
  }
  if (opts.show) {
    log.info("");
    log.info(pc.dim("─".repeat(68)));
    log.info(manifest);
    log.info(pc.dim("─".repeat(68)));
  }

  log.dim(
    opts.show || opts.out
      ? "Dry run — nothing sent. Execute with `glint run`."
      : "Dry run — nothing sent. Add `--show` to see the manifest, or run it with `glint run`.",
  );
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.min(100, Math.round((part / whole) * 100))}%`;
}
