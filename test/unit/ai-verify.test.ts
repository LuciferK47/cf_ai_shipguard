import { describe, expect, it } from "vitest";
import { fnv1a, verifyAnalysis } from "../../src/server/ai/verify";
import type { AiAnalysis, AiFindingRaw } from "../../src/server/ai/schemas";
import type { ShownFile } from "../../src/server/ai/prompts";
import type { Finding } from "../../src/shared/types";

const INDEX = [
  'import { Agent } from "agents";',
  "",
  "export class Bot extends Agent {",
  "  async run(env: Env) {",
  "    return env.MODEL.run(prompt);",
  "  }",
  "}"
].join("\n");

const LONG = Array.from(
  { length: 100 },
  (_, i) => `line ${i + 1} of the long file`
).join("\n");

const files = new Map([
  ["src/index.ts", INDEX],
  ["src/long.ts", LONG],
  ["src/hidden.ts", "export const hidden = 1;"]
]);

const shown: Record<string, ShownFile> = {
  "src/index.ts": { mode: "full", lineStart: 1, lineEnd: 7 },
  "src/long.ts": { mode: "partial", lineStart: 1, lineEnd: 40 }
  // src/hidden.ts was fetched but never shown to the model.
};

const finding = (over: Partial<AiFindingRaw> = {}): AiFindingRaw => ({
  severity: "high",
  confidence: 0.7,
  category: "bindings",
  title: "Code reads env.MODEL, which the config never defines",
  explanation: "The binding is named AI in the config.",
  recommendation: "Use env.AI.",
  evidence: [
    {
      path: "src/index.ts",
      lineStart: 5,
      lineEnd: 5,
      excerpt: "return env.MODEL.run(prompt);"
    }
  ],
  ...over
});

const analysis = (
  findings: AiFindingRaw[],
  over: Partial<AiAnalysis> = {}
): AiAnalysis => ({
  summary: "Summary.",
  priorities: [],
  plan: [],
  findings,
  ...over
});

const run = (
  raw: AiAnalysis,
  ruleFindings: Finding[] = [],
  refs: Record<string, string> = {}
) => verifyAnalysis({ raw, shown, files, ruleFindings, refs });

describe("verifyAnalysis: evidence", () => {
  it("accepts evidence that matches the shown text and uses the real excerpt", () => {
    const r = run(
      analysis([
        finding({
          evidence: [
            {
              path: "src/index.ts",
              lineStart: 5,
              excerpt: "  return   env.MODEL.run(prompt);  "
            }
          ]
        })
      ])
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence[0]).toEqual({
      path: "src/index.ts",
      lineStart: 5,
      lineEnd: 5,
      excerpt: "    return env.MODEL.run(prompt);"
    });
    expect(r.stats.accepted).toBe(1);
    expect(r.stats.excerptMismatches).toBe(0);
  });

  it("rejects a finding whose only evidence is a fabricated path", () => {
    const r = run(
      analysis([
        finding({ evidence: [{ path: "src/imaginary.ts", lineStart: 1 }] })
      ])
    );
    expect(r.findings).toEqual([]);
    expect(r.stats.invalidPaths).toBe(1);
    expect(r.stats.rejectedNoEvidence).toBe(1);
  });

  it("rejects a real path that the model was never shown", () => {
    const r = run(
      analysis([
        finding({ evidence: [{ path: "src/hidden.ts", lineStart: 1 }] })
      ])
    );
    expect(r.findings).toEqual([]);
    expect(r.stats.invalidPaths).toBe(1);
  });

  it("normalises ./ and leading slashes in paths", () => {
    const r = run(
      analysis([
        finding({ evidence: [{ path: "./src/index.ts", lineStart: 5 }] })
      ])
    );
    expect(r.findings[0].evidence[0].path).toBe("src/index.ts");
    const r2 = run(
      analysis([
        finding({ evidence: [{ path: "/src/index.ts", lineStart: 5 }] })
      ])
    );
    expect(r2.findings).toHaveLength(1);
  });

  it("drops evidence whose lines are beyond the file and cannot be repaired", () => {
    const r = run(
      analysis([
        finding({ evidence: [{ path: "src/index.ts", lineStart: 400 }] })
      ])
    );
    expect(r.findings).toEqual([]);
    expect(r.stats.invalidLines).toBe(1);
  });

  it("repairs wrong line numbers using the excerpt", () => {
    const r = run(
      analysis([
        finding({
          evidence: [
            {
              path: "src/index.ts",
              lineStart: 400,
              excerpt: "return env.MODEL.run(prompt);"
            }
          ]
        })
      ])
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence[0].lineStart).toBe(5);
  });

  it("supplies lines from the excerpt when the model gave none", () => {
    const r = run(
      analysis([
        finding({
          evidence: [
            {
              path: "src/index.ts",
              excerpt: "export class Bot extends Agent {"
            }
          ]
        })
      ])
    );
    expect(r.findings[0].evidence[0].lineStart).toBe(3);
  });

  it("enforces the shown window for partially shown files", () => {
    // The file has 100 lines but the model only saw 1-40.
    const r = run(
      analysis([
        finding({ evidence: [{ path: "src/long.ts", lineStart: 60 }] })
      ])
    );
    expect(r.findings).toEqual([]);
    expect(r.stats.invalidLines).toBe(1);
    const ok = run(
      analysis([
        finding({ evidence: [{ path: "src/long.ts", lineStart: 30 }] })
      ])
    );
    expect(ok.findings).toHaveLength(1);
  });

  it("clamps a range that runs past the shown window", () => {
    const r = run(
      analysis([
        finding({
          evidence: [{ path: "src/index.ts", lineStart: 6, lineEnd: 50 }]
        })
      ])
    );
    expect(r.findings[0].evidence[0].lineEnd).toBe(7);
  });

  it("caps evidence ranges at six lines", () => {
    const r = run(
      analysis([
        finding({
          evidence: [{ path: "src/long.ts", lineStart: 2, lineEnd: 30 }]
        })
      ])
    );
    expect(r.findings[0].evidence[0].lineEnd).toBe(7);
  });

  it("replaces a fabricated excerpt with the real text and lowers confidence", () => {
    const r = run(
      analysis([
        finding({
          evidence: [
            {
              path: "src/index.ts",
              lineStart: 5,
              excerpt: "await fetch(secretUrl)"
            }
          ]
        })
      ])
    );
    expect(r.findings[0].evidence[0].excerpt).toContain(
      "env.MODEL.run(prompt)"
    );
    expect(r.findings[0].evidence[0].excerpt).not.toContain("secretUrl");
    expect(r.stats.excerptMismatches).toBe(1);
    expect(r.findings[0].confidence).toBeCloseTo(0.56, 2);
  });

  it("keeps a finding if at least one evidence item is valid", () => {
    const r = run(
      analysis([
        finding({
          evidence: [
            { path: "nope.ts", lineStart: 1 },
            { path: "src/index.ts", lineStart: 5 }
          ]
        })
      ])
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence).toHaveLength(1);
    expect(r.stats.evidenceItems).toBe(2);
    expect(r.stats.evidenceAccepted).toBe(1);
  });

  it("accepts path-only evidence at reduced confidence", () => {
    const r = run(
      analysis([finding({ evidence: [{ path: "src/index.ts" }] })])
    );
    expect(r.findings[0].evidence[0]).toEqual({ path: "src/index.ts" });
    expect(r.findings[0].confidence).toBeCloseTo(0.6, 2);
  });
});

describe("verifyAnalysis: trust limits", () => {
  it("never lets a model finding be critical", () => {
    expect(
      run(analysis([finding({ severity: "critical" })])).findings[0].severity
    ).toBe("high");
  });

  it("caps confidence", () => {
    expect(
      run(analysis([finding({ confidence: 1 })])).findings[0].confidence
    ).toBe(0.85);
  });

  it("labels findings as AI with a stable fingerprint", () => {
    const a = run(analysis([finding()])).findings[0];
    const b = run(analysis([finding()])).findings[0];
    expect(a.source).toBe("ai");
    expect(a.ruleId).toBe("AI_ANALYSIS");
    expect(a.fingerprint).toMatch(/^AI:[0-9a-f]{8}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(
      run(analysis([finding({ title: "A different problem entirely" })]))
        .findings[0].fingerprint
    ).not.toBe(a.fingerprint);
  });

  it("redacts secrets echoed by the model and strips control characters", () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const r = run(
      analysis(
        [
          finding({
            explanation: `Leaks ${key}\u0007 here`,
            recommendation: "ok"
          })
        ],
        { summary: `Found ${key}` }
      )
    );
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.findings[0].explanation).not.toContain("\u0007");
    expect(r.summary).toContain("[REDACTED]");
  });

  it("drops a finding that duplicates a rule finding by evidence overlap", () => {
    const rule: Finding = {
      fingerprint: "CF_AI_BINDING_MISSING:x",
      ruleId: "CF_AI_BINDING_MISSING",
      source: "rule",
      severity: "high",
      confidence: 0.9,
      category: "bindings",
      title: "Something else entirely",
      explanation: "",
      recommendation: "",
      evidence: [{ path: "src/index.ts", lineStart: 4, lineEnd: 6 }]
    };
    const r = run(analysis([finding()]), [rule]);
    expect(r.findings).toEqual([]);
    expect(r.stats.duplicates).toBe(1);
  });

  it("drops a finding whose title restates a rule finding", () => {
    const rule: Finding = {
      fingerprint: "R:x",
      ruleId: "R",
      source: "rule",
      severity: "high",
      confidence: 0.9,
      category: "c",
      title: "Code uses env.MODEL but config never defines it",
      explanation: "",
      recommendation: "",
      evidence: []
    };
    expect(run(analysis([finding()]), [rule]).stats.duplicates).toBe(1);
  });

  it("removes duplicate model findings", () => {
    const r = run(analysis([finding(), finding()]));
    expect(r.findings).toHaveLength(1);
    expect(r.stats.duplicates).toBe(1);
  });
});

describe("verifyAnalysis: priorities and plan", () => {
  it("maps refs to fingerprints and drops unknown or repeated refs", () => {
    const r = run(
      analysis([], {
        priorities: [
          { ref: "r2", why: "first" },
          { ref: "R9", why: "made up" },
          { ref: "R2", why: "again" },
          { ref: "R1", why: "second" }
        ]
      }),
      [],
      { R1: "A:x", R2: "B:y" }
    );
    expect(r.priorities).toEqual([
      { fingerprint: "B:y", why: "first" },
      { fingerprint: "A:x", why: "second" }
    ]);
    expect(r.stats.invalidRefs).toBe(1);
  });

  it("cleans the plan", () => {
    const r = run(analysis([], { plan: ["  step one  ", "", "step two"] }));
    expect(r.plan).toEqual(["step one", "step two"]);
  });

  it("copes with no findings", () => {
    const r = run(analysis([]));
    expect(r.findings).toEqual([]);
    expect(r.stats.proposed).toBe(0);
  });
});

describe("fnv1a", () => {
  it("is deterministic and 8 hex characters", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
  });
});
