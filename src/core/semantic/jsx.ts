import { Project, SyntaxKind, ts, type Node, type JsxOpeningElement, type JsxSelfClosingElement } from "ts-morph";
import { normalizeText, landmarkFrom, type UIElement, type ComponentDef } from "./types";

const JSX_FILE = /\.(tsx|jsx)$/;
const LOOP_METHODS = new Set(["map", "forEach", "flatMap"]);

/** Parse JSX/TSX files into UI elements + the component definitions they contain. */
export function parseJsxFiles(contents: Map<string, string>): { elements: UIElement[]; components: ComponentDef[] } {
  const files = [...contents].filter(([f]) => JSX_FILE.test(f));
  if (files.length === 0) return { elements: [], components: [] };

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
  });

  const elements: UIElement[] = [];
  const components: ComponentDef[] = [];
  for (const [file, content] of files) {
    try {
      const sf = project.createSourceFile(`/${file}`, content, { overwrite: true });
      collectComponents(sf, file, components);
      for (const el of sf.getDescendantsOfKind(SyntaxKind.JsxElement)) {
        elements.push(fromElement(el, el.getOpeningElement(), el.getJsxChildren(), file));
      }
      for (const el of sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
        elements.push(fromElement(el, el, [], file));
      }
    } catch {
      // A file that doesn't parse cleanly shouldn't sink the whole analysis.
    }
  }
  return { elements, components };
}

function fromElement(
  node: Node,
  opening: JsxOpeningElement | JsxSelfClosingElement,
  children: Node[],
  file: string,
): UIElement {
  const tag = opening.getTagNameNode().getText();
  const isComponent = /^[A-Z]/.test(tag) || tag.includes(".");
  const role = isComponent ? tag : tag.toLowerCase();

  const attributes: Record<string, string> = {};
  for (const attr of opening.getAttributes()) {
    if (!attr.isKind(SyntaxKind.JsxAttribute)) continue;
    const name = attr.getNameNode().getText();
    const init = attr.getInitializer();
    if (!init) {
      attributes[name] = "true";
    } else if (init.isKind(SyntaxKind.StringLiteral)) {
      attributes[name] = init.getLiteralText();
    } else if (init.isKind(SyntaxKind.JsxExpression)) {
      const inner = init.getExpression();
      if (inner?.isKind(SyntaxKind.StringLiteral)) attributes[name] = inner.getLiteralText();
    }
  }
  const id = attributes.id ?? "";
  const classes = (attributes.className ?? attributes.class ?? "").split(/\s+/).filter(Boolean);

  let text = "";
  let hasDynamicText = false;
  for (const c of children) {
    if (c.isKind(SyntaxKind.JsxText)) {
      text += c.getText();
    } else if (c.isKind(SyntaxKind.JsxExpression)) {
      const e = c.getExpression();
      if (e?.isKind(SyntaxKind.StringLiteral)) text += e.getLiteralText();
      else if (e) hasDynamicText = true;
    }
  }

  const line = node.getStartLineNumber();
  const ancestry = jsxAncestry(node);
  return {
    file,
    line,
    endLine: node.getEndLineNumber(),
    role,
    kind: isComponent ? "component" : "html",
    text: normalizeText(text),
    hasDynamicText,
    attributes,
    id,
    classes,
    landmark: landmarkFrom(ancestry),
    ancestry: ancestry.map((a) => a.role),
    inLoop: isInLoop(node),
    key: `${file}:${line}`,
  };
}

function jsxAncestry(node: Node): { role: string; id?: string }[] {
  const chain: { role: string; id?: string }[] = [];
  for (const a of node.getAncestors()) {
    let opening: JsxOpeningElement | JsxSelfClosingElement | undefined;
    if (a.isKind(SyntaxKind.JsxElement)) opening = a.getOpeningElement();
    else if (a.isKind(SyntaxKind.JsxSelfClosingElement)) opening = a;
    if (!opening) continue;
    const tag = opening.getTagNameNode().getText();
    const role = /^[A-Z]/.test(tag) || tag.includes(".") ? tag : tag.toLowerCase();
    chain.push({ role, id: staticIdOf(opening) });
  }
  return chain.reverse(); // getAncestors is innermost→outermost; want outermost→innermost
}

function staticIdOf(opening: JsxOpeningElement | JsxSelfClosingElement): string | undefined {
  for (const attr of opening.getAttributes()) {
    if (!attr.isKind(SyntaxKind.JsxAttribute)) continue;
    if (attr.getNameNode().getText() !== "id") continue;
    const init = attr.getInitializer();
    if (init?.isKind(SyntaxKind.StringLiteral)) return init.getLiteralText();
  }
  return undefined;
}

function isInLoop(node: Node): boolean {
  for (const a of node.getAncestors()) {
    if (!a.isKind(SyntaxKind.CallExpression)) continue;
    const expr = a.getExpression();
    if (expr.isKind(SyntaxKind.PropertyAccessExpression) && LOOP_METHODS.has(expr.getName())) return true;
  }
  return false;
}

function collectComponents(sf: Node & { getFunctions?: unknown }, file: string, out: ComponentDef[]): void {
  const src = sf as unknown as import("ts-morph").SourceFile;
  for (const fn of src.getFunctions()) {
    const name = fn.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    if (rendersJsx(fn)) out.push({ name, file, line: fn.getStartLineNumber(), renders: [] });
  }
  for (const v of src.getVariableDeclarations()) {
    const name = v.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const init = v.getInitializer();
    if (!init || !(init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression))) continue;
    if (rendersJsx(init)) out.push({ name, file, line: v.getStartLineNumber(), renders: [] });
  }
}

function rendersJsx(node: Node): boolean {
  return Boolean(
    node.getFirstDescendantByKind(SyntaxKind.JsxElement) ?? node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement),
  );
}
