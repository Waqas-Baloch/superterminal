import { describe, it, expect } from "vitest";

// The project-name field is the only place a typed string becomes a path, so it
// is the only place a name could climb out of the folder the person chose.
// "../escape" must never be a project name.
const validateName = (v: string): true | string => {
  const t = String(v ?? "").trim();
  if (!t) return "Needs a name";
  if (/[/\\]|^\.\.?$/.test(t)) return "No slashes — this is a folder name, not a path";
  return true;
};

describe("new project names", () => {
  it.each(["my-app", "checkout_v2", "site.2026"])("accepts %s", (n) => {
    expect(validateName(n)).toBe(true);
  });

  it.each(["", "   "])("rejects empty (%s)", (n) => {
    expect(validateName(n)).not.toBe(true);
  });

  it.each(["../escape", "a/b", "..", ".", "nested\\win", "/etc/passwd"])("rejects path-shaped %s", (n) => {
    expect(validateName(n)).not.toBe(true);
  });
});
