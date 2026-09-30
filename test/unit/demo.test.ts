import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/server/checks";
import { loadFixture } from "../helpers/fixtures";

// The example Worker ships in two states: broken at the `demo-broken` git tag
// and fixed on `main`. The working tree holds the fixed state; the broken one is
// derived here by the same edits that were reverted for `main`, so both states
// are guarded by tests and the README's claims stay true.

const DEMO = join(import.meta.dirname, "..", "..", "examples", "demo-worker");

/** Undo the fixes: declare the wrong class name and drop the AI binding. */
function breakIt(path: string, text: string): string {
  if (path !== "wrangler.jsonc") return text;
  return text
    .replace('"DeploymentAgent": { "type": "durable-object"', '"DeployAgent": { "type": "durable-object"')
    .replace('  "ai": { "binding": "AI" },\n', "");
}

describe("the demo Worker", () => {
  it("on main has only the committed secret left", () => {
    const fx = loadFixture("demo", { dir: DEMO });
    const findings = runChecks(fx.ctx).findings;
    expect(findings.map((f) => f.ruleId)).toEqual(["CF_SECRET_IN_VARS"]);
    expect(findings[0].evidence[0].excerpt).toBe("WEBHOOK_SECRET: [REDACTED]");
    expect(JSON.stringify(findings)).not.toContain("4f9a1c");
  });

  it("at demo-broken has the four seeded problems", () => {
    const fx = loadFixture("demo", { dir: DEMO, transform: breakIt });
    const findings = runChecks(fx.ctx).findings;
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "CF_AI_BINDING_MISSING",
      "CF_CLASS_NOT_EXPORTED",
      "CF_DO_NOT_DECLARED",
      "CF_SECRET_IN_VARS"
    ]);
    const undeclared = findings.find((f) => f.ruleId === "CF_DO_NOT_DECLARED");
    expect(undeclared?.title).toContain("DeploymentAgent");
    const notExported = findings.find((f) => f.ruleId === "CF_CLASS_NOT_EXPORTED");
    expect(notExported?.title).toContain("DeployAgent");
  });

  it("keeps the same finding for the secret across both states, so memory can say it persists", () => {
    const broken = runChecks(loadFixture("demo", { dir: DEMO, transform: breakIt }).ctx).findings;
    const fixed = runChecks(loadFixture("demo", { dir: DEMO }).ctx).findings;
    const secret = (list: typeof fixed) => list.find((f) => f.ruleId === "CF_SECRET_IN_VARS")?.fingerprint;
    expect(secret(broken)).toBeDefined();
    expect(secret(broken)).toBe(secret(fixed));
  });
});
