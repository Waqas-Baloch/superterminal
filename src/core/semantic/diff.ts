import { buildElementGraph } from "./graph";
import type { ElementGraph, SymbolNode, UIElement } from "./types";

// Semantic diff: what an agent's edit *means*, not how many lines moved. Built
// by comparing the Target Graph before and after the run. The point is to turn
// a wall of "+42 −17" into statements a human can review in seconds — and to
// surface the two things line diffs hide: a deletion that leaves callers
// dangling, and changes the task never asked for.

export interface SemanticChange {
  kind: "removed" | "added" | "retext" | "reformat";
  summary: string; // one line, already human-readable
  warn: boolean; // deserves a ⚠️ — broken references or an unrequested change
}

export function semanticDiff(before: Map<string, string>, after: Map<string, string>): SemanticChange[] {
  const gb = buildElementGraph(before);
  const ga = buildElementGraph(after);
  const changes: SemanticChange[] = [];

  // ── Symbols: removed (with broken-reference check) and added ──────────────
  const beforeSyms = byNameFile(gb.symbols);
  const afterSyms = byNameFile(ga.symbols);
  const afterNames = new Set(ga.symbols.map((s) => s.name));

  for (const [id, s] of beforeSyms) {
    if (afterSyms.has(id)) continue;
    // Still referenced somewhere, and no other definition of the name remains?
    const stillUsed = !afterNames.has(s.name) && countReferences(after, s.name) > 0;
    changes.push({
      kind: "removed",
      summary: stillUsed
        ? `removed ${s.exported ? "exported " : ""}${s.kind} ${s.name} — ${countReferences(after, s.name)} reference${
            countReferences(after, s.name) === 1 ? "" : "s"
          } now unresolved`
        : `removed ${s.exported ? "exported " : ""}${s.kind} ${s.name}`,
      warn: stillUsed,
    });
  }
  for (const [id, s] of afterSyms) {
    if (!beforeSyms.has(id)) changes.push({ kind: "added", summary: `added ${s.kind} ${s.name}`, warn: false });
  }

  // ── Element copy: text that changed / appeared / disappeared ──────────────
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const b = elementTexts(gb, file);
    const a = elementTexts(ga, file);
    const removed = diffMultiset(b, a);
    const added = diffMultiset(a, b);
    if (removed.length === 1 && added.length === 1) {
      changes.push({ kind: "retext", summary: `${file}: text "${removed[0]}" → "${added[0]}"`, warn: false });
    } else {
      for (const t of removed) changes.push({ kind: "removed", summary: `${file}: removed "${t}"`, warn: false });
      for (const t of added) changes.push({ kind: "added", summary: `${file}: added "${t}"`, warn: false });
    }
  }

  // ── Files that changed on disk but carry no semantic change = reformat ────
  for (const [file, afterText] of after) {
    const beforeText = before.get(file);
    if (beforeText === undefined || beforeText === afterText) continue;
    const touched = changes.some((c) => c.summary.includes(file));
    const sameSymbols = sameNames(gb.symbols, ga.symbols, file);
    const sameText = setEq(new Set(elementTexts(gb, file)), new Set(elementTexts(ga, file)));
    if (!touched && sameSymbols && sameText) {
      changes.push({ kind: "reformat", summary: `${file}: reformatted only — no code or copy changed`, warn: true });
    }
  }

  return changes;
}

function byNameFile(syms: SymbolNode[]): Map<string, SymbolNode> {
  const m = new Map<string, SymbolNode>();
  for (const s of syms) m.set(`${s.file}::${s.name}`, s); // identity that survives line shifts
  return m;
}

function elementTexts(g: ElementGraph, file: string): string[] {
  return g.elements.filter((e: UIElement) => e.file === file && e.text).map((e) => e.text);
}

/** Occurrences in `a` that aren't covered by `b` (multiset difference). */
function diffMultiset(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

function sameNames(before: SymbolNode[], after: SymbolNode[], file: string): boolean {
  const b = new Set(before.filter((s) => s.file === file).map((s) => s.name));
  const a = new Set(after.filter((s) => s.file === file).map((s) => s.name));
  return setEq(b, a);
}

function setEq<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Rough count of how many times a bare identifier still appears in the tree. */
function countReferences(contents: Map<string, string>, name: string): number {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let n = 0;
  for (const text of contents.values()) n += (text.match(re) ?? []).length;
  return n;
}
