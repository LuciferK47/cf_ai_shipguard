import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker entry", () => {
  it("reports health and which optional features are configured, never their values", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      ok: boolean;
      model: string;
      features: Record<string, boolean>;
    };
    expect(body.ok).toBe(true);
    expect(body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(body.features).toEqual({
      githubToken: false,
      aiGateway: false,
      analysisCache: true
    });
    expect(JSON.stringify(body)).not.toMatch(/ghp_|token":"/);
  });

  it("serves an agent only under a UUID workspace id", async () => {
    const id = crypto.randomUUID();
    const ok = await SELF.fetch(
      `https://example.com/agents/ship-guard-agent/${id}/get-messages`
    );
    expect(ok.status).toBe(200);
  });

  it.each([
    [
      "a name that is not a UUID",
      "/agents/ship-guard-agent/not-a-uuid/get-messages"
    ],
    ["a guessable name", "/agents/ship-guard-agent/default/get-messages"],
    [
      "a name with traversal",
      "/agents/ship-guard-agent/..%2f..%2fadmin/get-messages"
    ],
    ["no instance name", "/agents/ship-guard-agent"],
    ["an unrelated path", "/admin"],
    [
      "a UUID with the wrong shape",
      "/agents/ship-guard-agent/12345678-1234-1234-1234-12345678901/get-messages"
    ]
  ])("refuses %s", async (_label, path) => {
    const res = await SELF.fetch(`https://example.com${path}`);
    expect(res.status).toBe(404);
  });

  it("refuses an agent class that does not exist", async () => {
    const res = await SELF.fetch(
      `https://example.com/agents/other-agent/${crypto.randomUUID()}/get-messages`
    );
    // The framework answers before our hook runs; either way it is refused.
    expect([400, 404]).toContain(res.status);
  });
});
