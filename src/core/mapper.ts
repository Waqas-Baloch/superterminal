import { promises as fs } from "node:fs";
import nodePath from "node:path";
import posix from "node:path/posix";
import { Project, ts } from "ts-morph";
import type { RepoIndex } from "./indexer";

export interface FileNode {
  path: string;
  imports: string[]; // resolved repo-relative paths
  importedBy: string[]; // reverse edges
  exports: string[]; // exported symbol names
  externals: string[]; // npm packages imported
}

export interface RepoGraph {
  nodes: Map<string, FileNode>;
}

export interface Alias {
  prefix: string; // e.g. "@/"
  targets: string[]; // e.g. ["src/"]
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const DOM_EXTS = new Set([".html", ".htm", ".css", ".scss"]);

export async function buildGraph(root: string, index: RepoIndex): Promise<RepoGraph> {
  const nodes = new Map<string, FileNode>();
  for (const f of index.files) {
    nodes.set(f.path, { path: f.path, imports: [], importedBy: [], exports: [], externals: [] });
  }
  const fileSet = new Set(nodes.keys());
  const aliases = loadAliases(root);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });

  const sourcePaths = index.files.filter((f) => SOURCE_EXTS.has(f.ext)).map((f) => f.path);
  for (const rel of sourcePaths) {
    try {
      project.addSourceFileAtPath(nodePath.join(root, rel));
    } catch {
      // unreadable/unparseable — leave as a bare node
    }
  }

  for (const rel of sourcePaths) {
    const sf = project.getSourceFile(nodePath.join(root, rel));
    if (!sf) continue;
    const node = nodes.get(rel)!;

    const specs = [
      ...sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
      ...sf
        .getExportDeclarations()
        .map((d) => d.getModuleSpecifierValue())
        .filter((s): s is string => Boolean(s)),
    ];
    for (const spec of specs) {
      const resolved = resolveImport(rel, spec, fileSet, aliases);
      if (resolved) {
        node.imports.push(resolved);
      } else if (!spec.startsWith(".")) {
        node.externals.push(packageName(spec));
      }
    }

    try {
      node.exports = [...sf.getExportedDeclarations().keys()];
    } catch {
      // unresolvable re-exports or syntax errors — exports stay empty
    }

    node.imports = [...new Set(node.imports)];
    node.externals = [...new Set(node.externals)];
  }

  // HTML/CSS have no exports, but they do have structure. Ids, class
  // definitions, headings, and CSS selectors act as their "symbols" so the
  // selector can tell a page that DEFINES #pricing from pages that merely
  // link to it in a shared nav bar.
  for (const f of index.files) {
    if (!DOM_EXTS.has(f.ext)) continue;
    const content = await fs.readFile(nodePath.join(root, f.path), "utf8").catch(() => "");
    nodes.get(f.path)!.exports = extractDomSymbols(content, f.ext);
  }

  for (const node of nodes.values()) {
    for (const imp of node.imports) nodes.get(imp)?.importedBy.push(node.path);
  }

  return { nodes };
}

function extractDomSymbols(content: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === ".html" || ext === ".htm") {
    for (const m of content.matchAll(/\bid=["']([^"']+)["']/g)) out.add(m[1]);
    for (const m of content.matchAll(/\bclass=["']([^"']+)["']/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls) out.add(cls);
    }
    for (const m of content.matchAll(/<h[1-3][^>]*>([^<]{1,80})/g)) {
      for (const word of m[1].trim().split(/\s+/)) if (word.length > 2) out.add(word);
    }
  } else {
    // css/scss: class and id selector names
    for (const m of content.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return [...out].slice(0, 200);
}

export function loadAliases(root: string): Alias[] {
  // ts.readConfigFile tolerates comments/trailing commas, unlike JSON.parse
  const result = ts.readConfigFile(nodePath.join(root, "tsconfig.json"), ts.sys.readFile);
  const co = result.config?.compilerOptions;
  if (!co?.paths) return [];

  const baseUrl: string = co.baseUrl ?? ".";
  const aliases: Alias[] = [];
  for (const [pattern, targets] of Object.entries(co.paths as Record<string, string[]>)) {
    if (!pattern.endsWith("*")) continue;
    aliases.push({
      prefix: pattern.slice(0, -1),
      targets: targets
        .filter((t) => t.endsWith("*"))
        .map((t) => posix.normalize(posix.join(baseUrl, t.slice(0, -1)))),
    });
  }
  return aliases;
}

function resolveImport(fromFile: string, spec: string, files: Set<string>, aliases: Alias[]): string | null {
  if (spec.startsWith(".")) {
    return probe(posix.normalize(posix.join(posix.dirname(fromFile), spec)), files);
  }
  for (const alias of aliases) {
    if (!spec.startsWith(alias.prefix)) continue;
    const rest = spec.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const hit = probe(posix.normalize(posix.join(target, rest)), files);
      if (hit) return hit;
    }
  }
  return null;
}

function probe(p: string, files: Set<string>): string | null {
  if (files.has(p)) return p; // exact match, e.g. ./styles.css or ./data.json
  // NodeNext-style "./foo.js" pointing at foo.ts
  if (p.endsWith(".js")) {
    const stem = p.slice(0, -3);
    for (const ext of [".ts", ".tsx"]) if (files.has(stem + ext)) return stem + ext;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    if (files.has(p + ext)) return p + ext;
  }
  for (const idx of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
    if (files.has(p + idx)) return p + idx;
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
