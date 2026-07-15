import { Project, SyntaxKind, ts, type Node, type SourceFile } from "ts-morph";
import type { SymbolNode } from "./types";

// TS/JS symbol extraction. This is the non-UI half of the Target Graph: the
// things a user names in a backend, CLI, or library ("remove the formatDate
// helper", "rename createOrder"). Same downstream machinery as UI elements —
// resolve the name to nodes, then 1 = act, N = ask, wide blast radius = block.
const TS_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const DECL_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
] as const;

export function parseSymbols(contents: Map<string, string>): SymbolNode[] {
  const files = [...contents].filter(([f]) => TS_FILE.test(f));
  if (files.length === 0) return [];

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
  });

  const parsed: { file: string; sf: SourceFile }[] = [];
  for (const [file, content] of files) {
    // Give JS files a JSX-capable extension so `<div/>` in .js doesn't fail.
    const virtual = /\.(jsx?|mjs|cjs)$/.test(file) ? `/${file}.jsx` : `/${file}`;
    try {
      parsed.push({ file, sf: project.createSourceFile(virtual, content, { overwrite: true }) });
    } catch {
      // A file that doesn't parse shouldn't sink the analysis.
    }
  }

  const out: SymbolNode[] = [];
  for (const { file, sf } of parsed) {
    try {
      collectDeclarations(sf, file, out);
    } catch {
      /* keep going */
    }
  }

  // Blast radius: how many times each name is referenced across the scanned
  // files, excluding its own declaration sites. A deterministic identifier
  // count — not full type-aware resolution (that needs the whole program), but
  // enough to know that deleting this breaks N call sites.
  const usage = countIdentifiers(parsed);
  for (const s of out) {
    const declCount = out.filter((o) => o.name === s.name).length;
    s.refs = Math.max(0, (usage.get(s.name) ?? 0) - declCount);
  }
  return out;
}

function collectDeclarations(sf: SourceFile, file: string, out: SymbolNode[]): void {
  for (const kind of DECL_KINDS) {
    for (const decl of sf.getDescendantsOfKind(kind)) {
      const name = (decl as unknown as { getName?: () => string | undefined }).getName?.();
      if (!name) continue;
      out.push({
        name,
        kind: kindLabel(kind),
        file,
        line: decl.getStartLineNumber(),
        exported: isExported(decl),
        refs: 0,
        container: containerOf(decl),
        key: `${file}:${decl.getStartLineNumber()}:${name}`,
      });
    }
  }
  // `const foo = …` / `const Foo = () => …` — includes arrow-function helpers.
  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName();
    if (!name) continue;
    const init = v.getInitializer();
    const isFn = Boolean(
      init && (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression)),
    );
    out.push({
      name,
      kind: isFn ? "function" : "const",
      file,
      line: v.getStartLineNumber(),
      exported: isExported(v),
      refs: 0,
      container: containerOf(v),
      key: `${file}:${v.getStartLineNumber()}:${name}`,
    });
  }
}

function countIdentifiers(parsed: { file: string; sf: SourceFile }[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const { sf } of parsed) {
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const t = id.getText();
      usage.set(t, (usage.get(t) ?? 0) + 1);
    }
  }
  return usage;
}

function kindLabel(kind: (typeof DECL_KINDS)[number]): SymbolNode["kind"] {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
      return "function";
    case SyntaxKind.ClassDeclaration:
      return "class";
    case SyntaxKind.InterfaceDeclaration:
      return "interface";
    case SyntaxKind.TypeAliasDeclaration:
      return "type";
    default:
      return "enum";
  }
}

function isExported(decl: Node): boolean {
  const d = decl as unknown as { isExported?: () => boolean };
  try {
    return d.isExported?.() ?? false;
  } catch {
    return false;
  }
}

/** Nearest enclosing named class/function, for display ("inside UserService"). */
function containerOf(decl: Node): string {
  for (const a of decl.getAncestors()) {
    if (a.isKind(SyntaxKind.ClassDeclaration) || a.isKind(SyntaxKind.FunctionDeclaration)) {
      const n = a.getName();
      if (n) return n;
    }
  }
  return "";
}
