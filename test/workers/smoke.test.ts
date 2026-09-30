import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("workers runtime smoke test", () => {
  it("has the bindings the app needs", () => {
    expect(env.ShipGuardAgent).toBeDefined();
    expect(env.AUDIT_WORKFLOW).toBeDefined();
    expect(env.ANALYSIS_CACHE).toBeDefined();
    expect(env.AI).toBeDefined();
  });
});
