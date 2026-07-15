// The semantic element graph: a structural, parser-derived model of the UI in
// the selected files. This replaces regex text-matching — every node here comes
// from a real AST (ts-morph for JSX/TSX) or DOM (parse5 for HTML), so multi-line
// elements, React components, and list rendering are represented faithfully.

/** A landmark region used to tell otherwise-identical elements apart. */
export const LANDMARK_ROLES = new Set([
  "nav",
  "header",
  "footer",
  "main",
  "aside",
  "section",
  "form",
  "dialog",
  "table",
]);

/** Component names that read as landmarks even though they're not intrinsic tags. */
export const LANDMARK_NAME_RE = /^(nav(bar)?|header|footer|sidebar|hero|banner|section|topbar|masthead)$/i;

export interface UIElement {
  file: string;
  line: number; // 1-based line of the opening tag
  endLine: number;
  role: string; // intrinsic tag (lowercased) or component name
  kind: "html" | "component"; // React component (Capitalized/namespaced) vs intrinsic
  text: string; // normalized static visible text of direct children ("" if none)
  hasDynamicText: boolean; // text (or part of it) comes from an expression {…}
  attributes: Record<string, string>; // statically-known attribute values only
  id: string;
  classes: string[];
  landmark: string; // nearest enclosing landmark, e.g. "nav" or "section#pricing"
  ancestry: string[]; // ancestor roles, outermost → innermost
  inLoop: boolean; // rendered inside .map()/loop → many runtime instances from one source
  key: string; // stable id `${file}:${line}`
}

export interface ComponentDef {
  name: string;
  file: string;
  line: number;
  /** file:line keys of elements rendered directly by this component's body. */
  renders: string[];
}

/**
 * A named declaration a user can point at in non-UI code — the backend/CLI/
 * library half of the Target Graph. `refs` is the blast radius: how many call
 * sites break if this is deleted.
 */
export interface SymbolNode {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "const";
  file: string;
  line: number;
  exported: boolean;
  refs: number;
  container: string; // enclosing class/function, for display
  key: string;
}

export interface ElementGraph {
  elements: UIElement[];
  /** Declared symbols (functions/classes/types/consts) across the scanned files. */
  symbols: SymbolNode[];
  /** component name → its definition (if defined within the scanned files). */
  components: Map<string, ComponentDef>;
  /** component name → every place it is instantiated. */
  instancesByComponent: Map<string, UIElement[]>;
}

export function emptyGraph(): ElementGraph {
  return { elements: [], symbols: [], components: new Map(), instancesByComponent: new Map() };
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Nearest landmark from an ancestry chain (innermost wins), or "". */
export function landmarkFrom(ancestry: { role: string; id?: string }[]): string {
  for (let i = ancestry.length - 1; i >= 0; i--) {
    const a = ancestry[i];
    const role = a.role.toLowerCase();
    if (LANDMARK_ROLES.has(role) || LANDMARK_NAME_RE.test(a.role)) {
      const tag = LANDMARK_NAME_RE.test(a.role) && !LANDMARK_ROLES.has(role) ? role.replace(/bar$/, "") : role;
      return a.id ? `${tag}#${a.id}` : tag;
    }
  }
  return "";
}
