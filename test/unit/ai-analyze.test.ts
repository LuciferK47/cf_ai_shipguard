import { describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/server/ai/analyze";
import {
  LlmError,
  classifyError,
  type LlmClient,
  type LlmRequest
} from "../../src/server/ai/llm";
import { buildAnalysisPrompt } from "../../src/server/ai/prompts";

const prompt = buildAnalysisPrompt({
  target: { owner: "o", repo: "r", subpath: "" },
  sha: "a".repeat(40),
  facts: [],
  ruleFindings: [],
  files: [],
  coverage: {
    sourceFilesTotal: 0,
    sourceFilesFetched: 0,
    neverFetched: [],
    treeTruncated: false,
    skipped: {},
    otherProjects: []
  }
});

const good = { summary: "ok", priorities: [], plan: [], findings: [] };

type Step = { output: unknown } | { error: unknown };

function fake(steps: Step[]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    model: "fake",
    requests,
    async generateJson(req) {
      requests.push(req);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if ("error" in step) throw step.error;
      return {
        output: step.output,
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: 5
      };
    }
  };
}

describe("runAnalysis", () => {
  it("succeeds on the first valid answer", async () => {
    const c = fake([{ output: good }]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({
      status: "ok",
      calls: 1,
      repaired: false,
      inputTokens: 100,
      outputTokens: 20
    });
    expect(c.requests[0].user).toBe(prompt.user);
  });

  it("repairs once when the first answer is not valid JSON", async () => {
    const c = fake([{ output: "Sure, here you go: {oops" }, { output: good }]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({
      status: "ok",
      calls: 2,
      repaired: true,
      inputTokens: 200
    });
    expect(c.requests[1].user).toContain("YOUR PREVIOUS REPLY WAS REJECTED");
    expect(c.requests[1].user).toContain("not valid JSON");
    expect(c.requests[1].user).toContain("Sure, here you go");
  });

  it("repairs a schema violation and tells the model what was wrong", async () => {
    const c = fake([
      { output: { ...good, findings: [{ severity: "meh" }] } },
      { output: good }
    ]);
    const r = await runAnalysis(c, prompt);
    expect(r.status).toBe("ok");
    expect(c.requests[1].user).toContain("does not match the schema");
  });

  it("gives up after the call cap and reports an invalid-output failure", async () => {
    const c = fake([{ output: "nope" }]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({
      status: "failed",
      code: "AI_INVALID_OUTPUT",
      calls: 2
    });
    expect(c.requests).toHaveLength(2);
  });

  it("never exceeds a smaller call cap", async () => {
    const c = fake([{ output: "nope" }]);
    const r = await runAnalysis(c, prompt, 1);
    expect(r.calls).toBe(1);
    expect(c.requests).toHaveLength(1);
  });

  it("does not retry when the allocation is exhausted", async () => {
    const c = fake([
      {
        error: new Error(
          "4006: you have used up your daily free allocation of 10,000 neurons"
        )
      }
    ]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({
      status: "failed",
      code: "AI_UNAVAILABLE",
      calls: 1
    });
    expect(c.requests).toHaveLength(1);
    if (r.status === "failed") expect(r.message).toMatch(/allocation/);
  });

  it("retries a transient capacity error once", async () => {
    const c = fake([
      { error: new Error("3040: capacity temporarily exceeded") },
      { output: good }
    ]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({ status: "ok", calls: 2 });
  });

  it("loosens the schema after JSON mode cannot be satisfied", async () => {
    const c = fake([
      { error: new Error("JSON Mode couldn't be met") },
      { output: good }
    ]);
    const r = await runAnalysis(c, prompt);
    expect(r.status).toBe("ok");
    expect(JSON.stringify(c.requests[0].schema)).toContain("maxLength");
    expect(JSON.stringify(c.requests[1].schema)).not.toContain("maxLength");
  });

  it("reports an unexpected failure without retrying", async () => {
    const c = fake([{ error: new Error("kaboom") }]);
    const r = await runAnalysis(c, prompt);
    expect(r).toMatchObject({
      status: "failed",
      code: "AI_UNAVAILABLE",
      calls: 1
    });
  });

  it("truncates the previous answer echoed in a repair request", async () => {
    const c = fake([{ output: "x".repeat(20000) }, { output: good }]);
    await runAnalysis(c, prompt);
    expect(c.requests[1].user.length).toBeLessThan(prompt.user.length + 2500);
  });
});

describe("classifyError", () => {
  it("passes LlmError through", () => {
    const e = new LlmError("AI_UNAVAILABLE", "x");
    expect(classifyError(e)).toBe(e);
  });
  it.each([
    ["JSON Mode couldn't be met", "AI_INVALID_OUTPUT", true],
    ["you exceeded neurons", "AI_UNAVAILABLE", false],
    ["503 service unavailable", "AI_UNAVAILABLE", true],
    ["weird", "AI_UNAVAILABLE", false]
  ] as const)("classifies %j", (msg, code, retryable) => {
    const e = classifyError(new Error(msg));
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
  });
  it("does not leak the raw message", () => {
    expect(
      classifyError(new Error("token=abc123 leaked")).message
    ).not.toContain("abc123");
  });
  it("handles non-Error values", () => {
    expect(classifyError("string failure")).toBeInstanceOf(LlmError);
  });
});
