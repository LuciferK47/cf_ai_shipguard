import { beforeEach, describe, expect, it } from "vitest";
import {
  aiRequests,
  inAgent,
  newAgent,
  repoUrl,
  resetAll,
  runAudit
} from "./helpers";

beforeEach(resetAll);

describe("when the model misbehaves the audit still completes honestly", () => {
  it("keeps the rule findings when the model returns text that is not JSON", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("ai-garbage"));

    expect(audit.status).toBe("complete");
    expect(audit.aiStatus).toBe("failed");
    expect(audit.findings.map((f) => f.ruleId).sort()).toEqual([
      "CF_DO_DUPLICATE_TAG",
      "CF_DO_NOT_DECLARED"
    ]);
    expect(audit.findings.every((f) => f.source === "rule")).toBe(true);
    expect(audit.aiNote).toMatch(/JSON/);
    expect(audit.stages.find((s) => s.id === "ai")?.status).toBe("failed");
    // Every other stage still finished.
    expect(
      audit.stages
        .filter((s) => s.id !== "ai")
        .every((s) => s.status === "done")
    ).toBe(true);
    // Bounded: one attempt plus one repair, never more.
    expect((await aiRequests()).filter((r) => !r.stream)).toHaveLength(2);
    // The deterministic plan replaces the missing model plan, and the report says so.
    expect(audit.plan.length).toBeGreaterThan(0);
    const messages = await inAgent(agent, (a) => a.messages);
    const done = messages.find((m) => m.id === `audit-complete-${audit.id}`);
    const text = done?.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(text).toContain("deterministic rules only");
  });

  it("does not retry when the Workers AI allocation is used up", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("ai-quota"));
    expect(audit.status).toBe("complete");
    expect(audit.aiStatus).toBe("failed");
    expect(audit.aiNote).toMatch(/allocation/);
    expect(audit.findings).toHaveLength(2);
    expect((await aiRequests()).filter((r) => !r.stream)).toHaveLength(1);
  });

  it("repairs an invalid first answer with one more call", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("ai-flaky"));
    expect(audit.status).toBe("complete");
    expect(audit.aiStatus).toBe("ok");
    const calls = (await aiRequests()).filter((r) => !r.stream);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.find((m) => m.role === "user")?.content).toContain(
      "YOUR PREVIOUS REPLY WAS REJECTED"
    );
    expect(audit.summary).toContain("configuration problems");
  });

  it("verifies model findings against the shown files", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("ai-hallucination"));
    expect(audit.status).toBe("complete");
    expect(audit.aiStatus).toBe("ok");
    const ai = audit.findings.filter((f) => f.source === "ai");

    // The finding that cited a file that does not exist is rejected; the other is kept.
    expect(ai).toHaveLength(1);
    expect(audit.rejectedAiFindings).toBe(1);
    expect(ai[0].title).toBe(
      "Entry point may be unrelated to the configured name"
    );
    expect(ai[0].severity).toBe("high");
    expect(ai[0].confidence).toBeLessThan(0.7);
    // The fabricated excerpt was replaced by the real text on that line.
    expect(ai[0].evidence[0]).toMatchObject({
      path: "wrangler.jsonc",
      lineStart: 2
    });
    expect(ai[0].evidence[0].excerpt).toContain("broken-do-migration");
    expect(JSON.stringify(audit)).not.toContain("imaginary.ts");
    expect(JSON.stringify(audit)).not.toContain("no such text on that line");
    // Severity decides the order; within one severity a model finding is ranked after the rule findings.
    const high = audit.findings
      .filter((f) => f.severity === "high")
      .map((f) => f.source);
    expect(high).toEqual(["rule", "ai"]);
  });
});

describe("the analysis cache", () => {
  it("reuses an identical analysis instead of spending model calls", async () => {
    const first = await runAudit(await newAgent(), repoUrl("healthy-worker"));
    expect(first.aiStatus).toBe("ok");
    const second = await runAudit(await newAgent(), repoUrl("healthy-worker"));
    expect(second.aiStatus).toBe("cached");
    expect((await aiRequests()).filter((r) => !r.stream)).toHaveLength(1);
    expect(second.stages.find((s) => s.id === "ai")?.detail).toMatch(/cache/);
    expect(second.summary).toBe(first.summary);
  });

  it("does not reuse a cached analysis for a different repository state", async () => {
    await runAudit(await newAgent(), repoUrl("healthy-worker"));
    const other = await runAudit(
      await newAgent(),
      repoUrl("missing-ai-binding")
    );
    expect(other.aiStatus).toBe("ok");
    expect((await aiRequests()).filter((r) => !r.stream)).toHaveLength(2);
  });
});

describe("untrusted repository text", () => {
  it("reaches the model only inside a FILE block and never changes the outcome", async () => {
    const audit = await runAudit(await newAgent(), repoUrl("prompt-injection"));
    expect(audit.status).toBe("complete");
    expect(audit.findings).toEqual([]);
    expect(audit.aiStatus).toBe("ok");

    const [request] = (await aiRequests()).filter((r) => !r.stream);
    const user = request.messages.find((m) => m.role === "user")!.content;
    const system = request.messages.find((m) => m.role === "system")!.content;
    const start = user.indexOf('<<<FILE path="src/index.ts"');
    const end = user.indexOf("<<<END FILE>>>", start);
    const inject = user.indexOf("Ignore all previous instructions");
    expect(start).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(start);
    expect(inject).toBeLessThan(end);
    // The trusted instructions never contain the repository text.
    expect(system).not.toContain("CANARY-7Q4X");
    expect(system).toContain("untrusted repository text");
    // Nothing the report stores carries the injected instruction as authoritative output.
    expect(audit.summary).not.toContain("CANARY-7Q4X");
    expect(audit.plan.join(" ")).not.toContain("CANARY-7Q4X");
  });
});
