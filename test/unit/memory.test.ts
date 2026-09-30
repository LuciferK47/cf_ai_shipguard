import { beforeEach, describe, expect, it } from "vitest";
import { diffFindings } from "../../src/server/findings/diff";
import {
  displayId,
  findDisplayIds,
  parseDisplayId
} from "../../src/server/findings/ids";
import type { Db } from "../../src/server/memory/db";
import { initSchema } from "../../src/server/memory/schema";
import {
  countAuditsSince,
  createAudit,
  failAudit,
  getAuditDetail,
  getAuditSummary,
  getDispositions,
  getFindings,
  getRunningAudits,
  getStages,
  latestCompleteAudit,
  listAuditSummaries,
  loadMemoryView,
  makeHeadline,
  persistReport,
  pruneAudits,
  setDisposition,
  stagesForDisplay,
  upsertStage,
  type PersistInput
} from "../../src/server/memory/store";
import type { Finding, Manifest, Target } from "../../src/shared/types";
import { targetKey } from "../../src/server/github/target";
import { createTestDb } from "../helpers/sqlite";

const TARGET: Target = { owner: "acme", repo: "worker", subpath: "" };
const KEY = targetKey(TARGET);

const manifest: Manifest = {
  repo: "acme/worker",
  ref: "main",
  sha: "a".repeat(40),
  filesDiscovered: 10,
  filesSelected: 3,
  filesSkipped: 7,
  treeTruncated: false,
  selected: [],
  skipped: {},
  neverFetched: []
};

const finding = (
  rule: string,
  subject: string,
  severity: Finding["severity"] = "high"
): Finding => ({
  fingerprint: `${rule}:${subject}`,
  ruleId: rule,
  source: "rule",
  severity,
  confidence: 0.9,
  category: "durable-objects",
  title: `${rule} ${subject}`,
  explanation: "why",
  recommendation: "fix",
  evidence: [
    { path: "wrangler.jsonc", lineStart: 5, lineEnd: 5, excerpt: "x" }
  ],
  docsUrl: "https://developers.cloudflare.com/"
});

let db: Db;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 30, 12, 0, clock++)).toISOString();

function audit(
  id: string,
  findings: Finding[],
  over: Partial<PersistInput> = {},
  target: Target = TARGET
) {
  createAudit(db, { id, target, now: now() });
  return persistReport(db, {
    auditId: id,
    sha: id.padEnd(40, "0").slice(0, 40),
    ref: "main",
    findings,
    summary: "summary",
    plan: ["step"],
    manifest,
    aiStatus: "ok",
    rejectedAi: 0,
    now: now(),
    ...over
  });
}

beforeEach(() => {
  db = createTestDb();
  initSchema(db);
  clock = 0;
});

describe("schema", () => {
  it("is idempotent", () => {
    expect(() => {
      initSchema(db);
      initSchema(db);
    }).not.toThrow();
  });
});

describe("stages", () => {
  it("starts every stage as pending", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    const stages = getStages(db, "a1");
    expect(stages).toHaveLength(8);
    expect(stages.every((s) => s.status === "pending")).toBe(true);
  });

  it("moves forward and records detail and timing", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    upsertStage(db, "a1", "resolve", "done", "acme/worker@abc", 120, now());
    expect(getStages(db, "a1")[0]).toMatchObject({
      status: "done",
      detail: "acme/worker@abc",
      ms: 120
    });
  });

  it("never regresses when a replayed report arrives late", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    upsertStage(db, "a1", "tree", "done", "first", 10, now());
    upsertStage(db, "a1", "tree", "running", "replay", 99, now());
    upsertStage(db, "a1", "tree", "pending", "replay", 99, now());
    expect(getStages(db, "a1")[1]).toMatchObject({
      status: "done",
      detail: "first",
      ms: 10
    });
  });

  it("keeps the first result when a retry reports done again", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    upsertStage(db, "a1", "tree", "done", "attempt 1", 10, now());
    upsertStage(db, "a1", "tree", "done", "attempt 2", 500, now());
    expect(getStages(db, "a1")[1]).toMatchObject({
      detail: "attempt 1",
      ms: 10
    });
  });

  it("ignores unknown stage names", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    expect(upsertStage(db, "a1", "bogus", "done", "x", 1, now())).toBe(false);
  });

  it("shows the first unfinished stage as running only while the audit runs", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    upsertStage(db, "a1", "resolve", "done", undefined, 1, now());
    const running = stagesForDisplay(getStages(db, "a1"), true);
    expect(running.map((s) => s.status).slice(0, 3)).toEqual([
      "done",
      "running",
      "pending"
    ]);
    const idle = stagesForDisplay(getStages(db, "a1"), false);
    expect(idle.some((s) => s.status === "running")).toBe(false);
  });
});

describe("persistReport", () => {
  it("assigns stable display ids in severity order and counts findings", () => {
    const s = audit("a1", [
      finding("R1", "x", "critical"),
      finding("R2", "y", "high"),
      finding("R3", "z", "medium")
    ]);
    expect(s.status).toBe("complete");
    expect(s.counts).toMatchObject({ critical: 1, high: 1, medium: 1 });
    expect(s.headline).toBe("3 findings: 1 critical, 1 high, 1 medium");
    expect(getFindings(db, "a1").map((f) => [f.displayId, f.ruleId])).toEqual([
      ["F-001", "R1"],
      ["F-002", "R2"],
      ["F-003", "R3"]
    ]);
  });

  it("is idempotent: persisting again changes nothing and allocates no ids", () => {
    const list = [finding("R1", "x"), finding("R2", "y")];
    audit("a1", list);
    const before = getFindings(db, "a1");
    const again = persistReport(db, {
      auditId: "a1",
      sha: "b".repeat(40),
      ref: "other",
      findings: [...list, finding("R9", "new")],
      summary: "different",
      plan: [],
      manifest,
      aiStatus: "ok",
      rejectedAi: 0,
      now: now()
    });
    expect(again.status).toBe("complete");
    expect(getFindings(db, "a1")).toEqual(before);
    // The next audit continues numbering from where the first left off.
    audit("a2", [finding("R1", "x"), finding("R2", "y"), finding("R3", "z")]);
    expect(
      getFindings(db, "a2").find((f) => f.ruleId === "R3")?.displayId
    ).toBe("F-003");
  });

  it("keeps display ids stable across audits and never reuses one", () => {
    audit("a1", [finding("R1", "x"), finding("R2", "y")]);
    audit("a2", [finding("R2", "y"), finding("R3", "z")]);
    audit("a3", [finding("R1", "x"), finding("R2", "y"), finding("R3", "z")]);
    const ids = (a: string) =>
      Object.fromEntries(
        getFindings(db, a).map((f) => [f.ruleId, f.displayId])
      );
    expect(ids("a1")).toEqual({ R1: "F-001", R2: "F-002" });
    expect(ids("a2")).toEqual({ R2: "F-002", R3: "F-003" });
    expect(ids("a3")).toEqual({ R1: "F-001", R2: "F-002", R3: "F-003" });
  });

  it("reports new, persisting and resolved findings against the previous audit", () => {
    audit("a1", [finding("R1", "x"), finding("R2", "y")]);
    audit("a2", [finding("R2", "y"), finding("R3", "z")]);
    const d = getAuditDetail(db, "a2");
    expect(d?.previousAuditId).toBe("a1");
    expect(d?.changes).toMatchObject({
      "R2:y": "persisting",
      "R3:z": "new",
      "R1:x": "resolved"
    });
    expect(d?.resolved.map((f) => f.displayId)).toEqual(["F-001"]);
    expect(d?.findings.map((f) => f.displayId).sort()).toEqual([
      "F-002",
      "F-003"
    ]);
  });

  it("treats the first audit of a target as all new with nothing resolved", () => {
    audit("a1", [finding("R1", "x")]);
    const d = getAuditDetail(db, "a1");
    expect(d?.previousAuditId).toBeUndefined();
    expect(d?.resolved).toEqual([]);
    expect(d?.changes["R1:x"]).toBe("new");
  });

  it("compares only against a completed audit, skipping failed and running ones", () => {
    audit("a1", [finding("R1", "x")]);
    createAudit(db, { id: "bad", target: TARGET, now: now() });
    failAudit(db, "bad", { code: "NOT_FOUND", message: "gone" }, now());
    createAudit(db, { id: "busy", target: TARGET, now: now() });
    audit("a2", [finding("R1", "x")]);
    expect(getAuditDetail(db, "a2")?.previousAuditId).toBe("a1");
  });

  it("numbers findings separately for each target", () => {
    const other: Target = { owner: "acme", repo: "other", subpath: "" };
    audit("a1", [finding("R1", "x")]);
    audit("b1", [finding("R1", "x")], {}, other);
    expect(getFindings(db, "b1")[0].displayId).toBe("F-001");
    expect(getFindings(db, "a1")[0].displayId).toBe("F-001");
  });

  it("round-trips evidence, docs links and the manifest", () => {
    audit("a1", [finding("R1", "x")]);
    const d = getAuditDetail(db, "a1");
    expect(d?.findings[0].evidence).toEqual([
      { path: "wrangler.jsonc", lineStart: 5, lineEnd: 5, excerpt: "x" }
    ]);
    expect(d?.findings[0].docsUrl).toBe("https://developers.cloudflare.com/");
    expect(d?.manifest.filesDiscovered).toBe(10);
    expect(d?.plan).toEqual(["step"]);
  });

  it("records the AI status and note", () => {
    audit("a1", [], { aiStatus: "failed", aiNote: "invalid output" });
    expect(getAuditDetail(db, "a1")).toMatchObject({
      aiStatus: "failed",
      aiNote: "invalid output",
      headline: "No findings"
    });
  });

  it("throws for an unknown audit", () => {
    expect(() =>
      persistReport(db, {
        auditId: "nope",
        sha: "",
        ref: "",
        findings: [],
        summary: "",
        plan: [],
        manifest,
        aiStatus: "ok",
        rejectedAi: 0,
        now: now()
      })
    ).toThrow(/Unknown audit/);
  });

  it("rolls back completely if a write fails midway", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    const bad = {
      ...finding("R1", "x"),
      evidence: [{ path: "p", lineStart: 1n as unknown as number }]
    };
    expect(() =>
      persistReport(db, {
        auditId: "a1",
        sha: "s",
        ref: "r",
        findings: [finding("R0", "ok"), bad],
        summary: "",
        plan: [],
        manifest,
        aiStatus: "ok",
        rejectedAi: 0,
        now: now()
      })
    ).toThrow();
    expect(getAuditSummary(db, "a1")?.status).toBe("running");
    expect(getFindings(db, "a1")).toEqual([]);
    // The id counter was rolled back too, so the next real report starts at F-001.
    audit("a2", [finding("R5", "z")]);
    expect(getFindings(db, "a2")[0].displayId).toBe("F-001");
  });
});

describe("failAudit", () => {
  it("marks the audit failed and the first unfinished stage failed", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    upsertStage(db, "a1", "resolve", "done", undefined, 1, now());
    failAudit(
      db,
      "a1",
      { code: "NOT_FOUND", message: "Repository not found" },
      now()
    );
    const s = getAuditSummary(db, "a1");
    expect(s).toMatchObject({
      status: "failed",
      headline: "Audit failed",
      error: { code: "NOT_FOUND" }
    });
    const stages = getStages(db, "a1");
    expect(stages[0].status).toBe("done");
    expect(stages[1]).toMatchObject({
      status: "failed",
      detail: "Repository not found"
    });
  });

  it("does not overwrite a completed audit", () => {
    audit("a1", [finding("R1", "x")]);
    failAudit(
      db,
      "a1",
      { code: "WORKFLOW_FAILED", message: "late error" },
      now()
    );
    expect(getAuditSummary(db, "a1")?.status).toBe("complete");
  });

  it("is idempotent", () => {
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    failAudit(db, "a1", { code: "NOT_FOUND", message: "first" }, now());
    failAudit(
      db,
      "a1",
      { code: "GITHUB_UNAVAILABLE", message: "second" },
      now()
    );
    expect(getAuditSummary(db, "a1")?.error?.message).toBe("first");
  });
});

describe("dispositions", () => {
  beforeEach(() => {
    audit("a1", [finding("R1", "x"), finding("R2", "y")]);
  });

  it("stores accept and dismiss by display id and surfaces them on the audit", () => {
    expect(
      setDisposition(db, KEY, "F-002", "dismissed", "known issue", now())
    ).toBe(true);
    expect(setDisposition(db, KEY, "f-001", "accepted", undefined, now())).toBe(
      true
    );
    const d = getAuditDetail(db, "a1");
    expect(d?.dispositions["R2:y"]).toEqual({
      status: "dismissed",
      note: "known issue"
    });
    expect(d?.dispositions["R1:x"].status).toBe("accepted");
  });

  it("rejects an unknown id", () => {
    expect(
      setDisposition(db, KEY, "F-099", "dismissed", undefined, now())
    ).toBe(false);
    expect(
      setDisposition(db, KEY, "not an id", "dismissed", undefined, now())
    ).toBe(false);
  });

  it("reopens by removing the disposition", () => {
    setDisposition(db, KEY, "F-001", "dismissed", "x", now());
    setDisposition(db, KEY, "F-001", "open", undefined, now());
    expect(getDispositions(db, KEY)).toEqual({});
  });

  it("survives later audits", () => {
    setDisposition(db, KEY, "F-001", "dismissed", "keep", now());
    audit("a2", [finding("R1", "x")]);
    expect(getAuditDetail(db, "a2")?.dispositions["R1:x"].status).toBe(
      "dismissed"
    );
  });
});

describe("pruning", () => {
  it("keeps the newest audits and removes the rest with their rows", () => {
    for (let i = 1; i <= 5; i++) audit(`a${i}`, [finding("R1", "x")]);
    const removed = pruneAudits(db, KEY, 3);
    expect(removed.sort()).toEqual(["a1", "a2"]);
    expect(getAuditSummary(db, "a1")).toBeUndefined();
    expect(getFindings(db, "a1")).toEqual([]);
    expect(getStages(db, "a1").every((s) => s.status === "pending")).toBe(true);
    expect(
      listAuditSummaries(db, { limit: 10, targetKey: KEY }).map((a) => a.id)
    ).toEqual(["a5", "a4", "a3"]);
  });

  it("keeps display ids and dispositions even after their audits are pruned", () => {
    audit("a1", [finding("R1", "x")]);
    setDisposition(db, KEY, "F-001", "dismissed", "n", now());
    for (let i = 2; i <= 4; i++) audit(`a${i}`, []);
    pruneAudits(db, KEY, 2);
    audit("a5", [finding("R1", "x")]);
    expect(getFindings(db, "a5")[0].displayId).toBe("F-001");
    expect(getAuditDetail(db, "a5")?.dispositions["R1:x"].status).toBe(
      "dismissed"
    );
  });

  it("never prunes a running audit", () => {
    createAudit(db, { id: "run", target: TARGET, now: now() });
    for (let i = 1; i <= 3; i++) audit(`a${i}`, []);
    pruneAudits(db, KEY, 1);
    expect(getAuditSummary(db, "run")?.status).toBe("running");
  });

  it("does nothing when under the limit", () => {
    audit("a1", []);
    expect(pruneAudits(db, KEY, 5)).toEqual([]);
  });
});

describe("queries", () => {
  it("counts audits since a time and lists running ones", () => {
    const t0 = now();
    createAudit(db, { id: "a1", target: TARGET, now: now() });
    createAudit(db, { id: "a2", target: TARGET, now: now() });
    expect(countAuditsSince(db, t0)).toBe(2);
    expect(countAuditsSince(db, "2999-01-01T00:00:00.000Z")).toBe(0);
    expect(getRunningAudits(db).map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("finds the latest completed audit", () => {
    audit("a1", []);
    audit("a2", []);
    createAudit(db, { id: "a3", target: TARGET, now: now() });
    expect(latestCompleteAudit(db, KEY)?.id).toBe("a2");
  });

  it("returns undefined for unknown audits", () => {
    expect(getAuditDetail(db, "nope")).toBeUndefined();
    expect(getAuditSummary(db, "nope")).toBeUndefined();
  });
});

describe("loadMemoryView (what the chat is grounded in)", () => {
  it("is empty without a target", () => {
    expect(loadMemoryView(db, undefined)).toEqual({ audits: [], history: {} });
  });

  it("shows whether each finding is present in each recent audit", () => {
    audit("a1", [finding("R1", "x"), finding("R2", "y")], {
      ref: "demo-broken"
    });
    audit("a2", [finding("R2", "y")], { ref: "main" });
    const view = loadMemoryView(db, KEY);
    expect(view.audits.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(view.latest?.id).toBe("a2");
    expect(view.history["F-001"].map((h) => [h.auditId, h.present])).toEqual([
      ["a2", false],
      ["a1", true]
    ]);
    expect(view.history["F-002"].every((h) => h.present)).toBe(true);
    expect(view.target).toMatchObject({ owner: "acme", repo: "worker" });
  });
});

describe("helpers", () => {
  it("formats display ids", () => {
    expect(displayId(3)).toBe("F-003");
    expect(displayId(1234)).toBe("F-1234");
    expect(parseDisplayId("f-7")).toBe("F-007");
    expect(parseDisplayId("F-")).toBeUndefined();
    expect(parseDisplayId("x")).toBeUndefined();
  });

  it("finds display ids in text", () => {
    expect(
      findDisplayIds("Is F-3 fixed? And f-012, F-3 again. Not F-abc or XF-5")
    ).toEqual(["F-003", "F-012"]);
  });

  it("builds headlines", () => {
    expect(
      makeHeadline({ critical: 0, high: 0, medium: 0, low: 0, info: 0 }, 0)
    ).toBe("No findings");
    expect(
      makeHeadline({ critical: 0, high: 1, medium: 0, low: 0, info: 0 }, 1)
    ).toBe("1 finding: 1 high");
  });

  it("diffs findings by fingerprint", () => {
    const d = diffFindings(
      [{ fingerprint: "a" }, { fingerprint: "b" }],
      [{ fingerprint: "b" }, { fingerprint: "c" }]
    );
    expect(d.changes).toEqual({ b: "persisting", c: "new" });
    expect(d.resolved).toEqual(["a"]);
    expect(diffFindings(undefined, [{ fingerprint: "x" }])).toEqual({
      changes: { x: "new" },
      resolved: []
    });
  });
});
