import { describe, expect, it } from "vitest";
import {
  analysisJsonSchema,
  parseAnalysis,
  simplifySchema,
  stripCodeFence
} from "../../src/server/ai/schemas";

const valid = {
  summary: "Two problems block deployment.",
  priorities: [{ ref: "R1", why: "Deploy fails without it." }],
  plan: ["Fix the binding", "Redeploy"],
  findings: [
    {
      severity: "high",
      confidence: 0.7,
      category: "bindings",
      title: "Wrong binding name",
      explanation: "The code reads env.MODEL but the config defines AI.",
      recommendation: "Rename the binding.",
      evidence: [
        {
          path: "src/index.ts",
          lineStart: 3,
          lineEnd: 3,
          excerpt: "env.MODEL.run()"
        }
      ]
    }
  ]
};

describe("parseAnalysis", () => {
  it("accepts a valid object", () => {
    const r = parseAnalysis(valid);
    expect(r.ok).toBe(true);
  });

  it("accepts a JSON string", () => {
    expect(parseAnalysis(JSON.stringify(valid)).ok).toBe(true);
  });

  it("accepts JSON wrapped in a Markdown fence", () => {
    expect(
      parseAnalysis("```json\n" + JSON.stringify(valid) + "\n```").ok
    ).toBe(true);
  });

  it("rejects text that is not JSON", () => {
    const r = parseAnalysis(
      "Sure! Here is my analysis: everything looks fine."
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  it("rejects truncated JSON", () => {
    const r = parseAnalysis(JSON.stringify(valid).slice(0, 80));
    expect(r.ok).toBe(false);
  });

  it("rejects a missing required field and names it", () => {
    const { summary: _s, ...rest } = valid;
    const r = parseAnalysis(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("summary");
  });

  it("rejects a bad severity", () => {
    const bad = {
      ...valid,
      findings: [{ ...valid.findings[0], severity: "catastrophic" }]
    };
    expect(parseAnalysis(bad).ok).toBe(false);
  });

  it("rejects a finding with no evidence", () => {
    const bad = {
      ...valid,
      findings: [{ ...valid.findings[0], evidence: [] }]
    };
    expect(parseAnalysis(bad).ok).toBe(false);
  });

  it("rejects out-of-range confidence and non-positive line numbers", () => {
    const conf = {
      ...valid,
      findings: [{ ...valid.findings[0], confidence: 1.5 }]
    };
    expect(parseAnalysis(conf).ok).toBe(false);
    const line = {
      ...valid,
      findings: [
        { ...valid.findings[0], evidence: [{ path: "a.ts", lineStart: 0 }] }
      ]
    };
    expect(parseAnalysis(line).ok).toBe(false);
  });

  it("rejects too many findings", () => {
    const many = {
      ...valid,
      findings: Array.from({ length: 20 }, () => valid.findings[0])
    };
    expect(parseAnalysis(many).ok).toBe(false);
  });

  it.each([null, undefined, 42, [], "[]", "null"])("rejects %j", (v) => {
    expect(parseAnalysis(v).ok).toBe(false);
  });

  it("does not throw on hostile input", () => {
    expect(() =>
      parseAnalysis({ findings: { length: 1 }, __proto__: { x: 1 } })
    ).not.toThrow();
  });
});

describe("stripCodeFence", () => {
  it("only strips a complete fence", () => {
    expect(stripCodeFence("```json\n{}\n```")).toBe("{}");
    expect(stripCodeFence("{}")).toBe("{}");
    expect(stripCodeFence("```json\n{}")).toBe("```json\n{}");
  });
});

describe("analysisJsonSchema", () => {
  it("describes the analysis object with required keys", () => {
    const s = analysisJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(s.type).toBe("object");
    expect(s.required).toEqual(
      expect.arrayContaining(["summary", "priorities", "plan", "findings"])
    );
    expect(Object.keys(s.properties)).toEqual([
      "summary",
      "priorities",
      "plan",
      "findings"
    ]);
    expect(JSON.stringify(s)).not.toContain("$schema");
  });

  it("keeps size limits in the full schema and removes them when simplified", () => {
    expect(JSON.stringify(analysisJsonSchema())).toContain("maxLength");
    const simple = JSON.stringify(analysisJsonSchema({ simplified: true }));
    for (const k of [
      "maxLength",
      "maxItems",
      "minimum",
      "maximum",
      "additionalProperties"
    ]) {
      expect(simple).not.toContain(k);
    }
    expect(simple).toContain("required");
    expect(simple).toContain("enum");
  });

  it("simplifySchema leaves scalars and arrays intact", () => {
    expect(simplifySchema([1, { maxItems: 2, a: 1 }])).toEqual([1, { a: 1 }]);
    expect(simplifySchema("x")).toBe("x");
  });
});
