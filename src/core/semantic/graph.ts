import { parseHtmlElements } from "./html";
import { parseJsxFiles } from "./jsx";
import { type ElementGraph, type UIElement, type ComponentDef } from "./types";

const HTML_FILE = /\.(html?|htm)$/;

/**
 * Build the semantic element graph for a set of files. Dispatches HTML to
 * parse5 and JSX/TSX to ts-morph, merges the element lists, and indexes
 * component definitions and their instantiation sites so the disambiguation
 * layer can reason about shared components and blast radius.
 */
export function buildElementGraph(contents: Map<string, string>): ElementGraph {
  const elements: UIElement[] = [];

  for (const [file, content] of contents) {
    if (!HTML_FILE.test(file)) continue;
    try {
      elements.push(...parseHtmlElements(file, content));
    } catch {
      // Malformed HTML shouldn't sink the analysis.
    }
  }

  const { elements: jsxEls, components: compList } = parseJsxFiles(contents);
  elements.push(...jsxEls);

  const components = new Map<string, ComponentDef>();
  for (const c of compList) if (!components.has(c.name)) components.set(c.name, c);

  const instancesByComponent = new Map<string, UIElement[]>();
  for (const el of elements) {
    if (el.kind !== "component") continue;
    const arr = instancesByComponent.get(el.role) ?? [];
    arr.push(el);
    instancesByComponent.set(el.role, arr);
  }

  return { elements, components, instancesByComponent };
}

export * from "./types";
