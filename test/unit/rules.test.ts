import { describe, expect, it } from "vitest";
import { RULES, runChecks } from "../../src/server/checks";
import type { Rule } from "../../src/server/checks/types";
import { listFixtures, loadFixture } from "../helpers/fixtures";

describe("deterministic rules against fixtures", () => {
  for (const name of listFixtures()) {
    describe(name, () => {
      const fx = loadFixture(name);
      const result = runChecks(fx.ctx);
      const ruleIds = [...new Set(result.findings.map((f) => f.ruleId))].sort();

      it("reports exactly the expected rules", () => {
        expect(ruleIds).toEqual(fx.expected.rules);
      });

      it("does not report rules listed as absent", () => {
        for (const id of fx.expected.absent) expect(ruleIds).not.toContain(id);
      });

      it("never skips a rule because of an internal error", () => {
        expect(result.skipped).toEqual([]);
      });

      it("gives every finding a docs link, a fingerprint and valid evidence lines", () => {
        for (const f of result.findings) {
          expect(f.docsUrl).toMatch(/^https:\/\//);
          expect(f.fingerprint.startsWith(`${f.ruleId}:`)).toBe(true);
          expect(f.source).toBe("rule");
          expect(f.confidence).toBeGreaterThan(0);
          expect(f.confidence).toBeLessThanOrEqual(1);
          for (const e of f.evidence) {
            if (e.lineStart === undefined) continue;
            const text = fx.ctx.files.get(e.path);
            if (text === undefined) continue; // evidence about a file that was never fetched
            const lineCount = text.split("\n").length;
            expect(e.lineStart).toBeGreaterThanOrEqual(1);
            expect(e.lineStart).toBeLessThanOrEqual(lineCount);
            expect(e.lineEnd ?? e.lineStart).toBeGreaterThanOrEqual(
              e.lineStart
            );
          }
        }
      });

      it("never leaks a secret value into a finding", () => {
        const json = JSON.stringify(result.findings);
        expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(json).not.toContain("sk_live_notarealkey");
      });
    });
  }
});

describe("rule engine", () => {
  it("has unique rule ids", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("isolates a rule that throws", () => {
    const boom: Rule = {
      id: "BOOM",
      run() {
        throw new Error("kaboom");
      }
    };
    const fx = loadFixture("healthy-worker");
    const result = runChecks(fx.ctx, [boom, ...RULES]);
    expect(result.skipped).toEqual([{ ruleId: "BOOM", reason: "kaboom" }]);
    expect(result.rulesRun.length).toBe(RULES.length);
  });

  it("orders findings by severity, then rule id", () => {
    const fx = loadFixture("exposed-secret-config");
    const order = ["critical", "high", "medium", "low", "info"];
    const sev = runChecks(fx.ctx).findings.map((f) =>
      order.indexOf(f.severity)
    );
    expect(sev).toEqual([...sev].sort((a, b) => a - b));
  });
});

describe("specific findings", () => {
  it("points the undeclared-class finding at the binding's class_name line", () => {
    const fx = loadFixture("broken-do-migration");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_DO_NOT_DECLARED"
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high");
    expect(f?.fingerprint).toBe("CF_DO_NOT_DECLARED:DeploymentAgent");
    const ev = f?.evidence[0];
    expect(ev?.path).toBe("wrangler.jsonc");
    const line = fx.ctx.files.get("wrangler.jsonc")?.split("\n")[
      (ev?.lineStart ?? 1) - 1
    ];
    expect(line).toContain("DeploymentAgent");
    expect(ev?.excerpt).toContain("DeploymentAgent");
  });

  it("reports the parse error at the right line and skips dependent checks", () => {
    const fx = loadFixture("malformed-wrangler");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_CONFIG_PARSE_ERROR"
    );
    expect(f?.severity).toBe("high");
    expect(f?.explanation).toMatch(/line \d+, column \d+/);
    expect(fx.ctx.primary).toBeUndefined();
  });

  it("treats a KV-backed Agent as high severity", () => {
    const fx = loadFixture("kv-agent");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_DO_KV_STORAGE"
    );
    expect(f?.severity).toBe("high");
    expect(f?.explanation).toMatch(/Agent/);
  });

  it("flags the secret var without echoing its value and ignores the placeholder", () => {
    const fx = loadFixture("exposed-secret-config");
    const vars = runChecks(fx.ctx).findings.filter(
      (x) => x.ruleId === "CF_SECRET_IN_VARS"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0].title).toContain("STRIPE_SECRET_KEY");
    expect(vars[0].evidence[0].excerpt).toBe("STRIPE_SECRET_KEY: [REDACTED]");
  });

  it("does not read secret-bearing files but still reports them", () => {
    const fx = loadFixture("exposed-secret-config");
    expect(fx.fetched).not.toContain(".dev.vars");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_ENV_FILE_COMMITTED"
    );
    expect(f?.evidence).toEqual([{ path: ".dev.vars" }]);
  });

  it("redacts secret patterns in source excerpts", () => {
    const fx = loadFixture("exposed-secret-config");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_SECRET_PATTERN"
    );
    expect(f?.severity).toBe("critical");
    expect(f?.evidence[0].excerpt).toContain("[REDACTED]");
  });

  it("lists other projects in a monorepo and audits the shallowest", () => {
    const fx = loadFixture("monorepo");
    expect(fx.ctx.base).toBe("apps/api");
    expect(fx.inventory.autoSelected).toBe(true);
    expect(fx.inventory.otherProjects).toEqual(["apps/web"]);
  });

  it("reports the missing config as informational for a plain Node project", () => {
    const fx = loadFixture("plain-node-project");
    const f = runChecks(fx.ctx).findings.find(
      (x) => x.ruleId === "CF_CONFIG_NOT_FOUND"
    );
    expect(f?.severity).toBe("info");
  });

  it("is not influenced by instruction-like text in the repository", () => {
    const fx = loadFixture("prompt-injection");
    expect(runChecks(fx.ctx).findings).toEqual([]);
  });

  it("does not raise the missing-config finding when a config exists", () => {
    const fx = loadFixture("healthy-worker");
    expect(runChecks(fx.ctx).findings.map((f) => f.ruleId)).not.toContain(
      "CF_CONFIG_NOT_FOUND"
    );
  });
});

describe("a file that could not be downloaded is not reported as missing", () => {
  it("says the config exists but could not be read, instead of 'not found'", () => {
    const fx = loadFixture("healthy-worker", { unread: ["wrangler.jsonc"] });
    const findings = runChecks(fx.ctx).findings;
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain("CF_CONFIG_UNREADABLE");
    expect(ids).not.toContain("CF_CONFIG_NOT_FOUND");
    const f = findings.find((x) => x.ruleId === "CF_CONFIG_UNREADABLE")!;
    expect(f.severity).toBe("medium");
    expect(f.explanation).toContain("GitHub did not answer in time");
    expect(f.explanation).toContain("audit is incomplete");
    expect(f.evidence).toEqual([{ path: "wrangler.jsonc" }]);
  });

  it("skips every configuration-dependent rule rather than guessing", () => {
    const fx = loadFixture("broken-do-migration", {
      unread: ["wrangler.jsonc"]
    });
    const ids = runChecks(fx.ctx).findings.map((f) => f.ruleId);
    expect(ids).toEqual(["CF_CONFIG_UNREADABLE"]);
  });

  it("still says 'not found' when the tree really has no config", () => {
    const fx = loadFixture("plain-node-project");
    expect(runChecks(fx.ctx).findings.map((f) => f.ruleId)).toEqual([
      "CF_CONFIG_NOT_FOUND"
    ]);
  });

  it("does not report a healthy, readable config as unreadable", () => {
    const fx = loadFixture("healthy-worker");
    expect(runChecks(fx.ctx).findings.map((f) => f.ruleId)).not.toContain(
      "CF_CONFIG_UNREADABLE"
    );
  });
});
