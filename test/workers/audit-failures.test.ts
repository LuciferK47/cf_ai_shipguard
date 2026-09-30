import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAudit } from "../../src/server/memory/store";
import { MAX_AUDITS_PER_HOUR } from "../../src/server/limits";
import {
  githubCalls,
  inAgent,
  newAgent,
  repoUrl,
  resetAll,
  runAudit,
  waitForAudit
} from "./helpers";

beforeEach(resetAll);

function messageTexts(
  messages: Array<{
    id: string;
    parts: Array<{ type: string; text?: string }>;
  }>,
  prefix: string
) {
  return messages
    .filter((m) => m.id.startsWith(prefix))
    .map((m) => m.parts.map((p) => p.text ?? "").join(""));
}

describe("user mistakes are rejected before any workflow starts", () => {
  it.each([
    ["not a URL", "hello"],
    ["another host", "https://gitlab.com/o/r"],
    ["http", "http://github.com/o/r"],
    ["a private-network host", "https://192.168.0.1/o/r"],
    ["a traversal", "https://github.com/o/r/tree/main/../../etc"]
  ])("rejects %s and creates nothing", async (_label, url) => {
    const agent = await newAgent();
    const started = await agent.startAudit(url);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe("INVALID_URL");
    const state = await inAgent(agent, (a) => a.state);
    expect(state.recent).toEqual([]);
    expect(state.running).toBeUndefined();
    expect(await githubCalls()).toEqual([]);
  });

  it("rejects a non-string argument", async () => {
    const agent = await newAgent();
    const started = await agent.startAudit(42 as unknown as string);
    expect(started.ok).toBe(false);
  });
});

describe("GitHub problems become clear, recorded failures", () => {
  it("reports a repository that does not exist", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("missing"));
    expect(audit.status).toBe("failed");
    expect(audit.error?.code).toBe("NOT_FOUND");
    expect(audit.error?.message).toMatch(/private/);
    expect(audit.headline).toBe("Audit failed");
    expect(audit.stages[0]).toMatchObject({ id: "resolve", status: "failed" });
    expect(audit.stages.slice(1).every((s) => s.status === "pending")).toBe(
      true
    );

    const messages = await inAgent(agent, (a) => a.messages);
    const failed = messageTexts(messages, "audit-failed-");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("could not be completed");
    expect(failed[0]).toContain("not found");
  });

  it("does not retry a repository that is missing", async () => {
    const agent = await newAgent();
    await runAudit(agent, repoUrl("missing"));
    const calls = (await githubCalls()).filter((c) =>
      c.url.includes("/repos/test/missing")
    );
    expect(calls).toHaveLength(1);
  });

  it("treats a private repository the same way", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("private-repo"));
    expect(audit.error?.code).toBe("NOT_FOUND");
  });

  it("reports a rate limit with its reset time and a hint about the token", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("ratelimited"));
    expect(audit.status).toBe("failed");
    expect(audit.error?.code).toBe("RATE_LIMITED");
    expect(audit.error?.message).toContain("2030-01-01");
    expect(audit.error?.message).toContain("GITHUB_TOKEN");
  });

  it("retries transient GitHub errors and then gives up with a clear message", async () => {
    const introspector = await introspectWorkflow(env.AUDIT_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    try {
      const audit = await runAudit(await newAgent(), repoUrl("flaky-github"));
      expect(audit.status).toBe("failed");
      expect(audit.error?.code).toBe("GITHUB_UNAVAILABLE");
      // One initial attempt plus two retries.
      const attempts = (await githubCalls()).filter((c) =>
        c.url.includes("/repos/test/flaky-github")
      );
      expect(attempts).toHaveLength(3);
    } finally {
      await introspector.dispose();
    }
  });

  it("explains a sub-directory that does not exist", async () => {
    const audit = await runAudit(
      await newAgent(),
      repoUrl("monorepo", "main/apps/nope")
    );
    expect(audit.status).toBe("failed");
    expect(audit.error?.code).toBe("NOT_FOUND");
    expect(audit.error?.message).toContain("apps/nope");
  });

  it("recovers: a failed audit does not block the next one", async () => {
    const agent = await newAgent();
    expect((await runAudit(agent, repoUrl("missing"))).status).toBe("failed");
    expect((await runAudit(agent, repoUrl("healthy-worker"))).status).toBe(
      "complete"
    );
  });

  it("never sends the token anywhere when none is configured", async () => {
    await runAudit(await newAgent(), repoUrl("healthy-worker"));
    expect((await githubCalls()).every((c) => !c.authorization)).toBe(true);
  });
});

describe("limits", () => {
  it("allows only one audit at a time in a workspace", async () => {
    const agent = await newAgent();
    await inAgent(agent, (a) =>
      createAudit(a["db"], {
        id: crypto.randomUUID(),
        target: { owner: "test", repo: "busy", subpath: "" },
        now: new Date().toISOString()
      })
    );
    const started = await agent.startAudit(repoUrl("healthy-worker"));
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe("LIMIT_REACHED");
      expect(started.error.message).toMatch(/already running/);
    }
    expect(await githubCalls()).toEqual([]);
  });

  it("caps how many audits a workspace can start per hour", async () => {
    const agent = await newAgent();
    await inAgent(agent, async (a) => {
      for (let i = 0; i < MAX_AUDITS_PER_HOUR; i++) {
        const id = crypto.randomUUID();
        createAudit(a["db"], {
          id,
          target: { owner: "test", repo: "old", subpath: "" },
          now: new Date().toISOString()
        });
        await a.reportFailure(id, { code: "NOT_FOUND", message: "gone" });
      }
    });
    const started = await agent.startAudit(repoUrl("healthy-worker"));
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe("LIMIT_REACHED");
      expect(started.error.message).toContain(String(MAX_AUDITS_PER_HOUR));
    }
  });
});

describe("stale audits", () => {
  it("marks an audit that lost its workflow as failed instead of running forever", async () => {
    const agent = await newAgent();
    const id = crypto.randomUUID();
    const longAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await inAgent(agent, (a) =>
      createAudit(a["db"], {
        id,
        target: { owner: "test", repo: "ghost", subpath: "" },
        now: longAgo
      })
    );

    await agent.refresh();
    const audit = await waitForAudit(agent, id);
    expect(audit.status).toBe("failed");
    expect(audit.error?.code).toBe("STALE");
    const state = await inAgent(agent, (a) => a.state);
    expect(state.running).toBeUndefined();
  });

  it("leaves a recent running audit alone", async () => {
    const agent = await newAgent();
    const id = crypto.randomUUID();
    await inAgent(agent, (a) =>
      createAudit(a["db"], {
        id,
        target: { owner: "test", repo: "fresh", subpath: "" },
        now: new Date().toISOString()
      })
    );
    await agent.refresh();
    expect((await agent.getAudit(id))?.status).toBe("running");
  });
});
