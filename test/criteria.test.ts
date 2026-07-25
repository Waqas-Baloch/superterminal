import { describe, it, expect } from "vitest";
import { parseCriteria, parseCriteriaVerdicts } from "../src/core/criteria";
import { renderRunReport, redactSecrets } from "../src/report/runReport";

describe("parseCriteria — the PM's checklist, wherever it was written", () => {
  it("reads an Acceptance Criteria heading with bullets", () => {
    const t = "Some intro\n## Acceptance Criteria\n- PayPal button appears next to card\n- Failed payment shows an error\n\nOther text";
    expect(parseCriteria(t)).toEqual(["PayPal button appears next to card", "Failed payment shows an error"]);
  });

  it("reads numbered lists and checkboxes under the heading", () => {
    const t = "Acceptance criteria:\n1. User can log in with Google\n2) Error shows for wrong password";
    expect(parseCriteria(t)).toHaveLength(2);
    const boxes = "- [ ] Works on mobile\n- [x] Loads under 2s";
    expect(parseCriteria(boxes)).toEqual(["Works on mobile", "Loads under 2s"]);
  });

  it("treats EARS-style lines as criteria even without a heading", () => {
    const t = "When the user clicks pay, the system shall show a receipt.";
    expect(parseCriteria(t)).toEqual([t]);
  });

  it("returns nothing for ordinary prose — review stays rules-only", () => {
    expect(parseCriteria("make the hero section bigger and bluer")).toEqual([]);
  });

  it("dedupes and caps — 300 criteria is a review of none", () => {
    const many = "## Acceptance criteria\n" + Array.from({ length: 40 }, (_, i) => `- criterion number ${i}`).join("\n");
    expect(parseCriteria(many).length).toBeLessThanOrEqual(20);
    expect(parseCriteria("## Acceptance criteria\n- Same thing here\n- same THING here")).toHaveLength(1);
  });
});

describe("parseCriteriaVerdicts — silence is never 'met'", () => {
  it("reads AC lines in the fixed format", () => {
    const v = parseCriteriaVerdicts("VERDICT: ISSUES\nAC1: MET\nAC2: NOT MET — refund flow untouched\nAC3: UNKNOWN — backend not in repo", 3);
    expect(v.map((x) => x.status)).toEqual(["met", "not_met", "unknown"]);
    expect(v[1].note).toContain("refund");
  });

  it("marks unaddressed criteria unknown, not met", () => {
    const v = parseCriteriaVerdicts("VERDICT: APPROVE\nAC1: MET", 3);
    expect(v[0].status).toBe("met");
    expect(v[1].status).toBe("unknown");
    expect(v[2].status).toBe("unknown");
  });

  it("tolerates bullet prefixes and case", () => {
    const v = parseCriteriaVerdicts("- ac1: not_met — missing", 1);
    expect(v[0].status).toBe("not_met");
  });
});

describe("run report — PM-readable, secret-free", () => {
  it("renders the criteria table with marks and counts", () => {
    const md = renderRunReport({
      task: "Add PayPal to checkout",
      agent: "Claude Code",
      reviewer: "ChatGPT (Codex)",
      approved: false,
      files: ["checkout.tsx"],
      criteria: ["PayPal button appears", "Refund flow works"],
      verdicts: [
        { index: 1, status: "met", note: "" },
        { index: 2, status: "not_met", note: "refund not attempted" },
      ],
      notes: ["refund handler missing"],
    });
    expect(md).toContain("1 of 2 met");
    expect(md).toContain("✓ 1. PayPal button appears");
    expect(md).toContain("✗ 2. Refund flow works");
    expect(md).toContain("super-t revert");
    expect(md).toContain("different vendor");
  });

  it("redacts token-shaped strings — reports travel to tickets", () => {
    expect(redactSecrets("used sk_live_abc123def456ghi to call the api")).not.toContain("sk_live_abc123def456ghi");
    expect(redactSecrets("header Bearer eyJhbGciOiJIUzI1NiJ9.payload")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});

describe("a report must never say criteria FAILED when nothing checked them", () => {
  const base = {
    task: "Implement ticket SUP-6: Home Page",
    agent: "ChatGPT (Codex)",
    files: ["index.html"],
    criteria: ["Headline says Ship with confidence", "Button matches brand blue"],
    notes: [],
  };

  it('says "not checked", never "0 of 2 met", when no review ran', () => {
    const md = renderRunReport({ ...base, verdicts: [], notCheckedReason: "no reviewer configured" });
    // The exact string that read as "the work failed" on a ticket a PM sees.
    expect(md).not.toContain("0 of 2 met");
    expect(md).toContain("not checked");
    expect(md).toContain("no reviewer configured");
  });

  it("still lists the criteria, marked as unchecked, and says how to enable checking", () => {
    const md = renderRunReport({ ...base, verdicts: [], notCheckedReason: "no reviewer configured" });
    expect(md).toContain("? 1. Headline says Ship with confidence");
    expect(md).toContain("? 2. Button matches brand blue");
    expect(md).toContain("review: codex");
  });

  it("distinguishes a review that failed to complete from one never configured", () => {
    const md = renderRunReport({ ...base, verdicts: [], notCheckedReason: "the review did not complete" });
    expect(md).toContain("the review did not complete");
  });

  it("a genuine 0-of-2 result is still reported as such", () => {
    const md = renderRunReport({
      ...base,
      reviewer: "Claude Code",
      verdicts: [
        { index: 1, status: "not_met", note: "headline unchanged" },
        { index: 2, status: "not_met", note: "colour untouched" },
      ],
    });
    expect(md).toContain("0 of 2 met");
    expect(md).not.toContain("not checked");
  });
});
