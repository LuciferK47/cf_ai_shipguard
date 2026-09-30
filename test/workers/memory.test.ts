import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShipGuardAgent } from "../../src/server/agent";
import type { UIMessage } from "ai";
import {
  aiRequests,
  inAgent,
  newAgent,
  readChatText,
  repoUrl,
  resetAll,
  runAudit
} from "./helpers";

beforeEach(resetAll);

const userMessage = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }]
});

/** Send a chat message straight to the agent's handler and return the streamed reply text. */
async function say(
  agent: Awaited<ReturnType<typeof newAgent>>,
  text: string
): Promise<string> {
  return inAgent(agent, async (a) => {
    a.messages = [...a.messages, userMessage(text)];
    return readChatText(await a.onChatMessage(undefined));
  });
}

const text = (m: UIMessage) =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("memory across audits: the reviewer demo", () => {
  it("remembers the first audit, sees the fix in the second, and answers from stored data", async () => {
    const agent = await newAgent();

    // 1. Audit the broken commit.
    const before = await runAudit(agent, repoUrl("flipflop", "broken"));
    expect(before.status).toBe("complete");
    expect(before.target.ref).toBe("broken");
    const doFinding = before.findings.find(
      (f) => f.ruleId === "CF_DO_NOT_DECLARED"
    );
    expect(doFinding?.displayId).toBeDefined();
    expect(before.previousAuditId).toBeUndefined();

    // 2. Audit the fixed commit of the same repository.
    const after = await runAudit(agent, repoUrl("flipflop", "main"));
    expect(after.status).toBe("complete");
    expect(after.previousAuditId).toBe(before.id);
    expect(after.sha).not.toBe(before.sha);
    expect(after.findings).toEqual([]);
    expect(after.resolved.map((f) => f.displayId).sort()).toEqual(
      before.findings.map((f) => f.displayId).sort()
    );
    expect(after.changes[doFinding!.fingerprint]).toBe("resolved");

    // 3. The completion message reports the change.
    const messages = await inAgent(agent, (a) => a.messages);
    const done = messages.find((m) => m.id === `audit-complete-${after.id}`)!;
    expect(text(done)).toContain("2 resolved, 0 still present, 0 new");
    expect(text(done)).toContain(doFinding!.displayId!);
  });

  it("answers 'did we fix it?' grounded in the stored audits, not in guesswork", async () => {
    const agent = await newAgent();
    const before = await runAudit(agent, repoUrl("flipflop", "broken"));
    await runAudit(agent, repoUrl("flipflop", "main"));
    const id = before.findings.find(
      (f) => f.ruleId === "CF_DO_NOT_DECLARED"
    )!.displayId!;

    const reply = await say(
      agent,
      `Did we fix ${id} from the previous investigation?`
    );
    expect(reply).toContain("Here is what I found in memory."); // the mock model's answer

    // What matters is what the model was given: the stored history, with the fix.
    const chat = (await aiRequests()).filter((r) => r.stream).at(-1)!;
    const system = chat.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("MEMORY (recorded by ShipGuard");
    expect(system).toContain(`DETAIL ${id}`);
    expect(system).toContain("Resolved:");
    expect(system).toContain("main@");
    expect(system).toContain("absent");
    expect(system).toContain("broken@");
    expect(system).toContain("present");
    expect(system).toContain("Durable Object class `DeploymentAgent`");
  });

  it("recalls an earlier finding by topic ('what migration issue did you find earlier?')", async () => {
    const agent = await newAgent();
    await runAudit(agent, repoUrl("flipflop", "broken"));
    await runAudit(agent, repoUrl("flipflop", "main"));
    await say(agent, "What migration issue did you find earlier?");
    const system = (await aiRequests())
      .filter((r) => r.stream)
      .at(-1)!
      .messages.find((m) => m.role === "system")!.content;
    expect(system).toMatch(/DETAIL F-00\d/);
    expect(system).toContain("migration");
  });

  it("keeps the same finding id when an issue is still present in a later audit", async () => {
    const agent = await newAgent();
    const first = await runAudit(agent, repoUrl("broken-do-migration"));
    const second = await runAudit(agent, repoUrl("broken-do-migration"));
    expect(second.findings.map((f) => [f.fingerprint, f.displayId])).toEqual(
      first.findings.map((f) => [f.fingerprint, f.displayId])
    );
    expect(Object.values(second.changes).every((c) => c === "persisting")).toBe(
      true
    );
    expect(second.resolved).toEqual([]);
  });

  it("says plainly that it knows nothing when nothing was audited", async () => {
    const agent = await newAgent();
    await say(agent, "What did you find earlier?");
    const system = (await aiRequests())
      .filter((r) => r.stream)
      .at(-1)!
      .messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("has not completed any audit");
    expect(system).not.toContain("DETAIL");
  });
});

describe("persistence: the investigation survives a disconnect", () => {
  it("keeps audits, findings and the conversation after the Durable Object is evicted", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("broken-do-migration"));
    const before = await inAgent(agent, (a) => ({
      ids: a.messages.map((m) => m.id),
      recent: a.state.recent.map((r) => r.id)
    }));

    await evictDurableObject(agent as unknown as DurableObjectStub);

    // A "reconnected" client addresses the same workspace and finds everything.
    const again = await getAgentByName<Env, ShipGuardAgent>(
      env.ShipGuardAgent,
      agent.workspaceId
    );
    const restored = await again.getAudit(audit.id);
    expect(restored?.status).toBe("complete");
    expect(restored?.findings.map((f) => f.displayId)).toEqual(
      audit.findings.map((f) => f.displayId)
    );
    const after = await inAgent(
      Object.assign(again, { workspaceId: agent.workspaceId }),
      (a) => ({
        ids: a.messages.map((m) => m.id),
        recent: a.state.recent.map((r) => r.id),
        active: a.state.activeTarget
      })
    );
    expect(after.ids).toEqual(before.ids);
    expect(after.recent).toEqual(before.recent);
    expect(after.active).toMatchObject({
      owner: "test",
      repo: "broken-do-migration"
    });
  });

  it("gives each workspace its own private memory", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const audit = await runAudit(a, repoUrl("broken-do-migration"));
    expect(await b.getAudit(audit.id)).toBeUndefined();
    expect((await inAgent(b, (x) => x.state)).recent).toEqual([]);
    expect(await inAgent(b, (x) => x.messages)).toEqual([]);
  });
});

describe("dispositions (decisions the developer makes)", () => {
  it("accepts and dismisses findings through chat and remembers them for later audits", async () => {
    const agent = await newAgent();
    const first = await runAudit(agent, repoUrl("broken-do-migration"));
    const dup = first.findings.find((f) => f.ruleId === "CF_DO_DUPLICATE_TAG")!;

    const reply = await say(
      agent,
      `dismiss ${dup.displayId} because it is intentional`
    );
    expect(reply).toContain(`Marked **${dup.displayId}** as dismissed`);
    // No model call is made for a command.
    expect((await aiRequests()).filter((r) => r.stream)).toHaveLength(0);

    const second = await runAudit(agent, repoUrl("broken-do-migration"));
    expect(second.dispositions[dup.fingerprint]).toEqual({
      status: "dismissed",
      note: "it is intentional"
    });
  });

  it("refuses an unknown finding id", async () => {
    const agent = await newAgent();
    await runAudit(agent, repoUrl("healthy-worker"));
    expect(await say(agent, "dismiss F-099")).toContain("no finding **F-099**");
  });

  it("works through the client-callable method too, and validates its input", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("broken-do-migration"));
    const id = audit.findings[0].displayId!;
    expect(await agent.setFindingStatus(id, "accepted", "will fix")).toBe(true);
    expect(await agent.setFindingStatus(id, "bogus" as never)).toBe(false);
    expect(await agent.setFindingStatus("F-099", "accepted")).toBe(false);
    expect(
      (await agent.getAudit(audit.id))?.dispositions[
        audit.findings[0].fingerprint
      ]
    ).toEqual({ status: "accepted", note: "will fix" });
  });
});

describe("idempotent persistence", () => {
  it("does not create a second report or a second message when the persist step is repeated", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("broken-do-migration"));
    const original = await agent.getAudit(audit.id);

    // Simulate a workflow retry delivering the same (or a different) report again.
    await inAgent(agent, (a) =>
      a.persistAuditReport({
        auditId: audit.id,
        sha: "f".repeat(40),
        ref: "elsewhere",
        findings: [],
        summary: "a different result",
        plan: [],
        manifest: original!.manifest,
        aiStatus: "ok",
        rejectedAi: 0,
        persistMs: 1
      })
    );

    const after = await agent.getAudit(audit.id);
    expect(after?.findings).toEqual(original?.findings);
    expect(after?.summary).toBe(original?.summary);
    expect(after?.sha).toBe(original?.sha);
    const messages = await inAgent(agent, (a) => a.messages);
    expect(
      messages.filter((m) => m.id === `audit-complete-${audit.id}`)
    ).toHaveLength(1);
  });
});

describe("chat routing without the model", () => {
  it("starts an audit from a pasted URL and replies deterministically", async () => {
    const agent = await newAgent();
    const reply = await say(
      agent,
      `Analyze ${repoUrl("healthy-worker")} before I deploy it`
    );
    expect(reply).toContain("Started audit");
    expect(reply).toContain("test/healthy-worker");
    expect((await aiRequests()).filter((r) => r.stream)).toHaveLength(0);
  });

  it("explains an invalid URL instead of guessing", async () => {
    const agent = await newAgent();
    const reply = await say(agent, "audit https://github.com/o/r/issues/1");
    expect(reply).toContain("public GitHub repositories");
  });

  it("re-audits the active project on request", async () => {
    const agent = await newAgent();
    await runAudit(agent, repoUrl("healthy-worker"));
    const reply = await say(agent, "please re-audit");
    expect(reply).toContain("Started audit");
    expect(reply).toContain("test/healthy-worker");
  });

  it("has nothing to re-audit before a first audit", async () => {
    const agent = await newAgent();
    await say(agent, "re-audit");
    // Without an active project this is just a question, answered from (empty) memory.
    const system = (await aiRequests())
      .filter((r) => r.stream)
      .at(-1)!
      .messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("has not completed any audit");
  });

  it("refuses an oversized message without calling the model", async () => {
    const agent = await newAgent();
    const reply = await say(agent, "x".repeat(5000));
    expect(reply).toContain("too long");
    expect(await aiRequests()).toHaveLength(0);
  });

  it("answers gracefully, without a stack trace, when the chat model is unavailable", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("ai-chat-down"));
    expect(audit.status).toBe("complete");
    const reply = await say(agent, "what did you find?");
    expect(reply).toContain("Workers AI is unavailable right now");
    expect(reply).toContain("still available in the panel");
    expect(reply).not.toMatch(/capacity|3040|Error|at .*\.ts/);
  });
});
