import pc from "picocolors";
import type { Selection, SelectedFile } from "../core/selector";
import { renderBox, type BoxRow } from "../report/box";
import { formatTokens } from "../util/tokens";
import { log } from "../util/logger";

// Extension → language label. Anything unknown lands in "Other files",
// so new languages degrade gracefully instead of disappearing.
const LANG_LABELS: [RegExp, string][] = [
  [/\.tsx?$/, "TypeScript"],
  [/\.(jsx?|mjs|cjs)$/, "JavaScript"],
  [/\.(html|htm)$/, "HTML"],
  [/\.(css|scss)$/, "CSS"],
  [/\.json$/, "JSON"],
  [/\.mdx?$/, "Markdown"],
  [/\.prisma$/, "Database schema"],
  [/\.(graphql|gql)$/, "GraphQL"],
  [/\.(yml|yaml)$/, "YAML"],
];

function langOf(path: string): string {
  for (const [re, label] of LANG_LABELS) {
    if (re.test(path)) return label;
  }
  return "Other files";
}

export function printSelection(selection: Selection): void {
  log.info("");
  log.info(`Task: ${pc.bold(selection.task)}`);
  log.info("");

  type Entry = { file: SelectedFile; tier: "full content" | "signatures only" };
  const groups = new Map<string, Entry[]>();
  const add = (file: SelectedFile, tier: Entry["tier"]) => {
    const lang = langOf(file.path);
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang)!.push({ file, tier });
  };
  for (const f of selection.primary) add(f, "full content");
  for (const f of selection.secondary) add(f, "signatures only");

  for (const [lang, entries] of groups) {
    const rows: BoxRow[] = [];
    for (const { file, tier } of entries) {
      rows.push({ left: file.path, right: `~${formatTokens(file.tokens)} tok`, kind: "main" });
      rows.push({ left: `  ${file.reasons[0]} · ${tier}`, kind: "sub" });
    }
    const title = `${lang} — ${entries.length} file${entries.length > 1 ? "s" : ""}`;
    for (const line of renderBox(title, rows)) log.info(line);
    log.info("");
  }
}

export function printManifestBox(opts: {
  tokens: number;
  budget: number;
  target: string;
  detail?: string;
}): void {
  const rows: BoxRow[] = [
    {
      left: `~${formatTokens(opts.tokens)} tokens of ${formatTokens(opts.budget)} budget`,
      right: `→ ${opts.target}`,
      kind: "main",
    },
  ];
  if (opts.detail) rows.push({ left: opts.detail, kind: "sub" });
  for (const line of renderBox("Manifest ready", rows)) log.info(line);
}
