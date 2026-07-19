import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { targetDescriptors, findMissingTargets, isModifyAction } from "../src/core/preflight";
import { buildIntentFrame } from "../src/core/understanding";

describe("targetDescriptors — the specific things a task names", () => {
  it("pulls quoted copy, code identifiers, and multi-word capitalized copy", () => {
    const d = targetDescriptors("remove Upgrade to Pro from the pricing page and get rid of the formatPrice function");
    expect(d).toContain("Upgrade to Pro");
    expect(d).toContain("formatPrice");
  });

  it("does not treat generic words as targets", () => {
    // "button", "the", "page" are not specific — nothing to verify exists.
    expect(targetDescriptors("make the button on the page bigger")).toEqual([]);
  });

  it("recognizes modify actions but not additive ones", () => {
    expect(isModifyAction(buildIntentFrame("remove the X").action)).toBe(true);
    expect(isModifyAction(buildIntentFrame("add a checkout form").action)).toBe(false);
  });
});

describe("findMissingTargets — the token-saving preflight", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-preflight-"));
    await fs.writeFile(path.join(dir, "index.html"), '<body><nav><button class="cta">Get it Now</button></nav></body>');
    await fs.writeFile(path.join(dir, "billing.ts"), "export function calcTotal(x: number) { return x; }\n");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const files = () => [
    { path: "index.html", size: 100 },
    { path: "billing.ts", size: 60 },
  ];

  it("reports every named target as missing when none exist (your exact case)", async () => {
    const named = targetDescriptors("remove Upgrade to Pro and the formatPrice function");
    const missing = await findMissingTargets(dir, files(), named);
    expect(missing).not.toBeNull();
    expect(missing!.sort()).toEqual(["Upgrade to Pro", "formatPrice"].sort());
  });

  it("reports nothing missing when the target is present", async () => {
    const missing = await findMissingTargets(dir, files(), targetDescriptors("rename the calcTotal function"));
    expect(missing).toEqual([]);
  });

  it("reports partial — one present, one absent → not a total no-op", async () => {
    const named = targetDescriptors("remove calcTotal and formatPrice");
    const missing = await findMissingTargets(dir, files(), named);
    expect(missing).toEqual(["formatPrice"]); // calcTotal exists, so the task isn't a no-op
  });

  it("stays silent (null) when the repo is too large to scan confidently", async () => {
    const huge = [{ path: "index.html", size: 20_000_000 }];
    expect(await findMissingTargets(dir, huge, ["formatPrice"])).toBeNull();
  });
});
