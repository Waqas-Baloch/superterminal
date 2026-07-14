import pc from "picocolors";
import type { Selection, SelectedFile } from "../core/selector";
import type { Band } from "../core/understanding";
import { renderBox, type BoxRow } from "../report/box";
import { formatTokens } from "../util/tokens";
import { log } from "../util/logger";

// Four-band classifier readout (spec §Decision bands). Orange has no named
// picocolors color, so it uses a 256-color escape (208) that degrades to the
// terminal default where unsupported.
const orange = (s: string): string => `\x1b[38;5;208m${s}\x1b[39m`;
const BANDS: Record<Band, { paint: (s: string) => string; label: string; behavior: string }> = {
  green: { paint: pc.green, label: "Green", behavior: "safe to execute" },
  yellow: { paint: pc.yellow, label: "Yellow", behavior: "target clear — continuing the existing style" },
  orange: { paint: orange, label: "Orange", behavior: "clarification needed" },
  red: { paint: pc.red, label: "Red", behavior: "unsafe — blocked pending clarification" },
};

export function printBand(band: Band, reason: string): void {
  const b = BANDS[band];
  log.info("");
  log.info(`${b.paint("●")} ${b.paint(pc.bold(b.label))} — ${b.behavior}`);
  if (reason) log.dim(`  ${reason}`);
}

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
  const confidencePct = Math.round(selection.taskConfidence * 100);
  log.dim(
    `Detected: ${selection.taskType} task (${confidencePct}% confidence)` +
      (selection.anchors.length > 0
        ? ` · anchors: ${selection.anchors.map((a) => a.path.split("/").pop()).join(", ")}`
        : ""),
  );
  log.info("");

  type Entry = { file: SelectedFile; tier: "primary" | "supporting" | "signatures only" };
  const groups = new Map<string, Entry[]>();
  const add = (file: SelectedFile, tier: Entry["tier"]) => {
    const lang = langOf(file.path);
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang)!.push({ file, tier });
  };
  for (const f of selection.primary) add(f, "primary");
  for (const f of selection.supporting) add(f, "supporting");
  for (const f of selection.optional) add(f, "signatures only");

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
