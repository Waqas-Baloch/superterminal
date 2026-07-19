import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { Project } from "ts-morph";
import { loadAliases } from "./mapper";
import { loadRules, renderRulesSection, loadContext, renderContextSection } from "./rules";
import { resolveMentions, readMentioned, renderMentionedSection } from "./mentions";
import { loadSkills, matchSkills, renderSkillsSection } from "./skills";
import { expandTask } from "./terms";
import { focusContent, type FocusResult } from "./focus";
import { estimateTokens } from "../util/tokens";
import type { Selection } from "./selector";

const LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".prisma": "prisma",
  ".md": "md",
  ".mdx": "md",
  ".yml": "yaml",
  ".yaml": "yaml",
};

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const MAX_SIGNATURES_PER_FILE = 30;
const FOCUS_MIN_TOKENS = 250; // below this, excerpting adds overhead instead of saving

// Honor the task's wording literally. Agents (especially subscription CLIs
// with a strong "be helpful / match surrounding style" bias) tend to soften
// destructive verbs — e.g. rewriting a button's text to match its siblings
// when the user said "remove". This framing reaches every provider because
// it lives in the manifest, not in Super Terminal's API-only system prompt.
const APPLY_GUIDANCE = `## How to apply this task
Do exactly what the task asks — no more, no less — and follow its wording literally:
- "remove" / "delete" / "get rid of" means take that element or code out **entirely** — do not replace its text, rename it, or rewrite it into something else.
- "rename" / "change the text" / "reword" means edit only that text, not restructure the element.
- Do not add, restyle, rename, or "improve" anything the task did not explicitly ask for, even if a nearby pattern looks inconsistent.
- If the task targets a **specific occurrence** (e.g. "only the one inside the navbar"), change that one alone. When several elements are byte-for-byte identical, a plain find-and-replace hits all of them — match by surrounding structure (the enclosing element/section) and expand the edit to include enough context to touch exactly the specified occurrence, leaving the others untouched.
Make the smallest change that *fully and literally* satisfies the request.`;

export async function generateManifest(opts: {
  root: string;
  task: string;
  selection: Selection;
  focus?: boolean; // default true — send task-relevant excerpts for large files
  sessionNote?: string; // follow-up context from the previous task in this session
}): Promise<string> {
  const { root, task, selection } = opts;
  const focusOn = opts.focus !== false;
  const terms = expandTask(task);
  const parts: string[] = [];

  parts.push("# Repo context manifest");
  parts.push(`## Task\n${task}`);
  parts.push(APPLY_GUIDANCE);
  // Project context first — what this project *is* — then the rules that
  // constrain the work. Both go to every agent.
  const contextSection = renderContextSection(await loadContext(root));
  if (contextSection) parts.push(contextSection);
  const rulesSection = renderRulesSection(await loadRules(root));
  if (rulesSection) parts.push(rulesSection);
  // Skills — team know-how, injected only when it matches this task.
  const skillsSection = renderSkillsSection(matchSkills(task, await loadSkills(root)));
  if (skillsSection) parts.push(skillsSection);
  // Any file the task named by hand (a brief, a checklist, a doc under any name).
  const mentioned = renderMentionedSection(await readMentioned(root, await resolveMentions(root, task)));
  if (mentioned) parts.push(mentioned);
  if (opts.sessionNote) parts.push(`## Session context\n${opts.sessionNote}`);
  parts.push(await projectFacts(root));

  // Primary (anchor units) + Supporting (owner/deps/consumers) both get full
  // content — the ranking spec's "smallest COMPLETE set" means a dependency
  // needed to safely make the edit shouldn't be reduced to just a signature.
  const fullFiles = [...selection.primary, ...selection.supporting];
  const tree = [
    ...fullFiles.map((f) => `${f.path}  (full)`),
    ...selection.optional.map((f) => `${f.path}  (signatures)`),
  ];
  parts.push(`## Selected files\n${tree.join("\n")}`);

  const fullChunks: string[] = [];
  for (const f of fullFiles) {
    const content = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => "");
    const lang = LANG[nodePath.extname(f.path)] ?? "";
    const focused = focusOn && estimateTokens(content) > FOCUS_MIN_TOKENS ? focusContent(content, terms) : null;
    if (focused) {
      fullChunks.push(renderExcerpts(f.path, lang, focused));
    } else {
      // 4-backtick fences so markdown files containing ``` don't break the manifest
      fullChunks.push(`### ${f.path}\n\`\`\`\`${lang}\n${content}\n\`\`\`\``);
    }
  }
  parts.push(`## Files (full content or task-relevant excerpts)\n${fullChunks.join("\n\n")}`);

  if (selection.optional.length > 0) {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true },
    });
    const sigChunks: string[] = [];
    for (const f of selection.optional) {
      sigChunks.push(`### ${f.path}\n${await signaturesFor(project, root, f.path)}`);
    }
    parts.push(`## Files (signatures only — use read_file for full content)\n${sigChunks.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

/** Greenfield: no source files to compress — a thin manifest that scaffolds. */
export async function generateScaffoldManifest(opts: {
  root: string;
  task: string;
  sessionNote?: string;
}): Promise<string> {
  const parts = ["# New project manifest", `## Task\n${opts.task}`];
  // Context matters most here — there's no code to infer intent from yet.
  const contextSection = renderContextSection(await loadContext(opts.root));
  if (contextSection) parts.push(contextSection);
  const rulesSection = renderRulesSection(await loadRules(opts.root));
  if (rulesSection) parts.push(rulesSection);
  const scaffoldMentions = renderMentionedSection(
    await readMentioned(opts.root, await resolveMentions(opts.root, opts.task)),
  );
  if (scaffoldMentions) parts.push(scaffoldMentions);
  if (opts.sessionNote) parts.push(`## Session context\n${opts.sessionNote}`);
  parts.push(await projectFacts(opts.root));
  parts.push(
    "## Notes\nThis directory has no source files yet — build the project from scratch. Use a minimal, conventional structure for the stack the task implies. Do not add heavyweight tooling, frameworks, or dependencies unless the task asks for them.",
  );
  return parts.join("\n\n");
}

function renderExcerpts(path: string, lang: string, focus: FocusResult): string {
  const body: string[] = [];
  let cursor = 0;
  for (const ex of focus.excerpts) {
    if (ex.start > cursor) body.push(`⋯ (lines ${cursor + 1}–${ex.start} omitted)`);
    body.push(ex.text);
    cursor = ex.end + 1;
  }
  if (cursor < focus.totalLines) body.push(`⋯ (lines ${cursor + 1}–${focus.totalLines} omitted)`);
  return `### ${path} (task-relevant excerpts — ${focus.shownLines} of ${focus.totalLines} lines; use read_file if you need more)\n\`\`\`\`${lang}\n${body.join("\n")}\n\`\`\`\``;
}

async function projectFacts(root: string): Promise<string> {
  const lines: string[] = ["## Project"];
  const pkg = await readJson(nodePath.join(root, "package.json"));
  if (pkg) {
    const deps: Record<string, string> = pkg.dependencies ?? {};
    const devDeps: Record<string, string> = pkg.devDependencies ?? {};
    const framework = deps.next ? `Next.js ${deps.next}` : deps.react ? `React ${deps.react}` : "Node/TypeScript";
    lines.push(`- name: ${pkg.name ?? "unknown"}`);
    lines.push(`- framework: ${framework}`);
    const depNames = Object.keys(deps);
    if (depNames.length > 0) lines.push(`- dependencies: ${depNames.slice(0, 25).join(", ")}`);
    if (devDeps.typescript) lines.push(`- typescript: ${devDeps.typescript}`);
    const scripts = Object.entries(pkg.scripts ?? {})
      .slice(0, 10)
      .map(([k, v]) => `${k}: \`${v}\``);
    if (scripts.length > 0) lines.push(`- scripts: ${scripts.join("; ")}`);
  }
  const aliases = loadAliases(root);
  if (aliases.length > 0) {
    lines.push(`- path aliases: ${aliases.map((a) => `${a.prefix}* → ${a.targets.join(",")}/*`).join("; ")}`);
  }
  return lines.join("\n");
}

async function signaturesFor(project: Project, root: string, rel: string): Promise<string> {
  const ext = nodePath.extname(rel);
  if (!TS_EXTS.has(ext)) {
    const content = await fs.readFile(nodePath.join(root, rel), "utf8").catch(() => "");
    const head = content.split("\n").slice(0, 12).join("\n");
    return `\`\`\`\`${LANG[ext] ?? ""}\n${head}\n\`\`\`\``;
  }
  try {
    const sf = project.addSourceFileAtPath(nodePath.join(root, rel));
    const lines: string[] = [];
    for (const [, decls] of sf.getExportedDeclarations()) {
      const decl = decls[0];
      if (!decl) continue;
      const kind = decl.getKindName();
      const text = decl.getText();
      if ((kind === "InterfaceDeclaration" || kind === "TypeAliasDeclaration") && text.split("\n").length <= 12) {
        lines.push(text); // full shape matters and it's short
      } else {
        lines.push(firstLine(text));
      }
      if (lines.length >= MAX_SIGNATURES_PER_FILE) break;
    }
    return lines.length > 0 ? `\`\`\`\`ts\n${lines.join("\n")}\n\`\`\`\`` : "(no exports)";
  } catch {
    return "(unavailable)";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].replace(/\s*\{$/, "");
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
