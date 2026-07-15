import { parse } from "parse5";
import { normalizeText, landmarkFrom, type UIElement } from "./types";

// Elements whose contents are code/metadata, not user-facing UI copy.
const SKIP = new Set(["script", "style", "noscript", "svg", "head", "meta", "link", "template"]);

interface P5Node {
  tagName?: string;
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  sourceCodeLocation?: { startLine: number; endLine: number; startCol: number } | null;
}

/** Parse an HTML file into UI elements with real ancestry, landmark, and lines. */
export function parseHtmlElements(file: string, content: string): UIElement[] {
  const doc = parse(content, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const body = findFirst(doc, "body") ?? doc;
  const out: UIElement[] = [];
  walk(body, [], out, file);
  return out;
}

function walk(node: P5Node, ancestry: { role: string; id?: string }[], out: UIElement[], file: string): void {
  for (const child of node.childNodes ?? []) {
    const role = child.tagName?.toLowerCase();
    if (!role) continue; // text/comment handled as parent's directText
    if (SKIP.has(role)) continue;

    const attributes: Record<string, string> = {};
    for (const a of child.attrs ?? []) attributes[a.name] = a.value;
    const id = attributes.id ?? "";
    const classes = (attributes.class ?? "").split(/\s+/).filter(Boolean);
    const line = child.sourceCodeLocation?.startLine ?? 0;

    out.push({
      file,
      line,
      endLine: child.sourceCodeLocation?.endLine ?? line,
      role,
      kind: "html",
      text: directText(child),
      hasDynamicText: false,
      attributes,
      id,
      classes,
      landmark: landmarkFrom(ancestry),
      ancestry: ancestry.map((a) => a.role),
      inLoop: false,
      key: `${file}:${line}:${child.sourceCodeLocation?.startCol ?? 0}`, // col disambiguates same-line elements
    });

    walk(child, [...ancestry, { role, id: id || undefined }], out, file);
  }
}

/** Concatenated direct #text children, normalized. */
function directText(node: P5Node): string {
  let t = "";
  for (const c of node.childNodes ?? []) if (c.nodeName === "#text") t += c.value ?? "";
  return normalizeText(t);
}

function findFirst(node: P5Node, tag: string): P5Node | null {
  for (const c of node.childNodes ?? []) {
    if (c.tagName?.toLowerCase() === tag) return c;
    const nested = findFirst(c, tag);
    if (nested) return nested;
  }
  return null;
}
