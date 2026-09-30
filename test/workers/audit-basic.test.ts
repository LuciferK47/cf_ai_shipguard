import { beforeEach, describe, expect, it } from "vitest";
import { STAGE_ORDER } from "../../src/shared/types";
import {
  aiRequests,
  inAgent,
  newAgent,
  repoUrl,
  resetAll,
  runAudit
} from "./helpers";

beforeEach(resetAll);

describe("a complete audit inside the Workers runtime", () => {
  it("audits a healthy Worker end to end", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("healthy-worker"));

    expect(audit.status).toBe("complete");
    expect(audit.findings).toEqual([]);
    expect(audit.headline).toBe("No findings");
    expect(audit.aiStatus).toBe("ok");
    expect(audit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(audit.stages.map((s) => s.id)).toEqual([...STAGE_ORDER]);
    for (const stage of audit.stages) {
      expect(stage.status, stage.id).toBe("done");
      expect(typeof stage.ms, stage.id).toBe("number");
    }
    expect(audit.manifest.selected.map((s) => s.path)).toEqual(
      expect.arrayContaining(["wrangler.jsonc", "package.json", "src/index.ts"])
    );
    expect(audit.manifest.selected.every((s) => s.fetched)).toBe(true);
  });

  it("finds the seeded Durable Object problem with real evidence lines", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("broken-do-migration"));

    expect(audit.status).toBe("complete");
    const ids = audit.findings.map((f) => f.ruleId).sort();
    expect(ids).toEqual(["CF_DO_DUPLICATE_TAG", "CF_DO_NOT_DECLARED"]);
    const undeclared = audit.findings.find(
      (f) => f.ruleId === "CF_DO_NOT_DECLARED"
    )!;
    expect(undeclared.displayId).toMatch(/^F-00\d$/);
    expect(undeclared.severity).toBe("high");
    expect(undeclared.evidence[0]).toMatchObject({
      path: "wrangler.jsonc",
      lineStart: 6
    });
    expect(undeclared.evidence[0].excerpt).toContain("DeploymentAgent");
  });

  it("puts a completion message in the conversation and updates the small shared state", async () => {
    const agent = await newAgent();
    const audit = await runAudit(agent, repoUrl("broken-do-migration"));

    const { messages, state } = await inAgent(agent, (instance) => ({
      messages: instance.messages,
      state: instance.state
    }));
    const done = messages.find((m) => m.id === `audit-complete-${audit.id}`);
    expect(done?.role).toBe("assistant");
    const text = done?.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(text).toContain("**Audit complete**");
    expect(text).toContain("F-00");
    expect(state.running).toBeUndefined();
    expect(state.recent[0]).toMatchObject({ id: audit.id, status: "complete" });
    expect(state.activeTarget).toMatchObject({
      owner: "test",
      repo: "broken-do-migration"
    });
  });

  it("sends the model only shown, numbered, delimited repository text", async () => {
    const agent = await newAgent();
    await runAudit(agent, repoUrl("broken-do-migration"));
    const requests = (await aiRequests()).filter((r) => !r.stream);
    expect(requests).toHaveLength(1);
    const user = requests[0].messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("AUDIT TARGET: test/broken-do-migration");
    expect(user).toContain('<<<FILE path="wrangler.jsonc"');
    expect(user).toMatch(/\n\s+6\| .*DeploymentAgent/);
    expect(user).toContain("R1 [high] CF_DO_NOT_DECLARED");
    expect(requests[0].messages[0].role).toBe("system");
  });
});
