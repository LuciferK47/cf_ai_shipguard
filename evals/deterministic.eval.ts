import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, fitsContext } from "../src/server/ai/prompts";
import { RULES, runChecks } from "../src/server/checks";
import { buildInventory, pickSources } from "../src/server/ingest/select";
import { MAX_FILES_FETCHED, MAX_TREE_ENTRIES } from "../src/server/limits";
import { listFixtures, loadFixture } from "../test/helpers/fixtures";

// Deterministic evaluation: how well do the rules find what is seeded in the
// fixtures, and how trustworthy is the evidence they attach?
//
// Every number is computed here from the fixtures in test/fixtures. Fixtures
// were written together with the rules, so this measures regression and
// internal consistency, not accuracy on unseen repositories; docs/EVALUATION.md
// says so plainly.

const OUT = join(import.meta.dirname, "results");

interface Row {
  fixture: string;
  expected: string[];
  actual: string[];
  exact: boolean;
  missed: string[];
  unexpected: string[];
}

const SECRETS = [
  ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "not-a-real-value-abc123def"
];

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

describe("deterministic evaluation", () => {
  const fixtures = listFixtures().map((name) => loadFixture(name));
  const rows: Row[] = [];
  const perRule = new Map<string, { tp: number; fp: number; fn: number }>();
  let evidenceItems = 0;
  let evidenceLinesOk = 0;
  let evidenceExcerptOk = 0;
  let evidenceExcerptSynthetic = 0;
  let evidencePathOk = 0;
  let evidenceWithLines = 0;
  let secretLeaks = 0;
  let totalFindings = 0;
  let ruleErrors = 0;
  let seededExtra = 0;

  for (const rule of RULES) perRule.set(rule.id, { tp: 0, fp: 0, fn: 0 });

  for (const fx of fixtures) {
    const result = runChecks(fx.ctx);
    ruleErrors += result.skipped.length;
    const actual = [...new Set(result.findings.map((f) => f.ruleId))].sort();
    const expected = fx.expected.rules;
    const missed = expected.filter((r) => !actual.includes(r));
    const unexpected = actual.filter((r) => !expected.includes(r));
    rows.push({
      fixture: fx.name,
      expected,
      actual,
      exact: missed.length === 0 && unexpected.length === 0,
      missed,
      unexpected
    });

    for (const id of new Set([...expected, ...actual])) {
      const m = perRule.get(id) ?? { tp: 0, fp: 0, fn: 0 };
      if (expected.includes(id) && actual.includes(id)) m.tp++;
      else if (actual.includes(id)) m.fp++;
      else m.fn++;
      perRule.set(id, m);
    }

    totalFindings += result.findings.length;
    const json = JSON.stringify(result.findings);
    for (const s of SECRETS) if (json.includes(s)) secretLeaks++;

    for (const f of result.findings) {
      for (const e of f.evidence) {
        evidenceItems++;
        const known =
          fx.ctx.files.has(e.path) ||
          fx.ctx.paths.has(e.path) ||
          fx.ctx.neverFetched.includes(e.path);
        if (known) evidencePathOk++;
        if (e.lineStart === undefined) continue;
        evidenceWithLines++;
        const text = fx.ctx.files.get(e.path);
        if (text === undefined) continue;
        const lines = text.split("\n");
        const end = e.lineEnd ?? e.lineStart;
        if (e.lineStart >= 1 && end <= lines.length && end >= e.lineStart)
          evidenceLinesOk++;
        if (e.excerpt !== undefined) {
          const real = normalise(lines.slice(e.lineStart - 1, end).join(" "));
          const shown = normalise(e.excerpt);
          // A synthetic excerpt ("NAME: [REDACTED]") stands in for a line whose
          // value must never be quoted, so it cannot match the file text.
          if (/^[\w.-]+: \[REDACTED\]$/.test(shown)) {
            evidenceExcerptSynthetic++;
            continue;
          }
          // Otherwise the excerpt must appear in the file, up to any redaction.
          const cut = shown.split("[REDACTED]")[0].replace(/…$/, "");
          if (cut === "" || real.includes(cut)) evidenceExcerptOk++;
        }
      }
    }
  }

  const seeded = rows.reduce((n, r) => n + r.expected.length, 0);
  const found = rows.reduce(
    (n, r) => n + (r.expected.length - r.missed.length),
    0
  );
  const clean = rows.filter((r) => r.expected.length === 0);
  const cleanWithFindings = clean.filter((r) => r.actual.length > 0);

  it("reports a config that could not be downloaded as unreadable, not as missing", () => {
    const fx = loadFixture("healthy-worker", { unread: ["wrangler.jsonc"] });
    const ids = runChecks(fx.ctx).findings.map((f) => f.ruleId);
    expect(ids).toEqual(["CF_CONFIG_UNREADABLE"]);
    // Counted with the other seeded scenarios so the rule appears in the scorecard.
    const m = perRule.get("CF_CONFIG_UNREADABLE") ?? { tp: 0, fp: 0, fn: 0 };
    m.tp++;
    perRule.set("CF_CONFIG_UNREADABLE", m);
    seededExtra++;
  });

  it("finds every seeded issue and reports nothing extra", () => {
    const bad = rows.filter((r) => !r.exact);
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
  });

  it("raises no false positives on the clean fixtures", () => {
    expect(cleanWithFindings.map((r) => r.fixture)).toEqual([]);
  });

  it("never lets a rule crash", () => {
    expect(ruleErrors).toBe(0);
  });

  it("attaches evidence that points at real files and real lines", () => {
    expect(evidencePathOk).toBe(evidenceItems);
    expect(evidenceLinesOk).toBeGreaterThan(0);
  });

  it("never leaks a planted secret into a finding", () => {
    expect(secretLeaks).toBe(0);
  });

  // A 30,000-file repository, measured once and used by the tests below.
  const oversized = (() => {
    const entries = [
      { path: "wrangler.jsonc", type: "blob" as const, size: 500 },
      { path: "package.json", type: "blob" as const, size: 500 },
      ...Array.from({ length: 30_000 }, (_, i) => ({
        path: `src/generated/m${i % 200}/file-${i}.ts`,
        type: "blob" as const,
        size: 3000
      }))
    ];
    const started = performance.now();
    const inventory = buildInventory(entries, "", false);
    const inventoryMs = performance.now() - started;
    const picks = pickSources(inventory, { slots: MAX_FILES_FETCHED - 2 });
    return { entries: entries.length, inventory, inventoryMs, picks };
  })();

  describe("an oversized repository", () => {
    const { inventory, inventoryMs, picks } = oversized;

    it("bounds what is indexed, ranked and fetched", () => {
      // Only the first MAX_TREE_ENTRIES entries are ever looked at.
      expect(oversized.entries).toBeGreaterThan(MAX_TREE_ENTRIES);
      expect(inventory.discovered).toBe(MAX_TREE_ENTRIES);
      expect(inventory.sourceCandidates.length).toBeLessThanOrEqual(60);
      expect(inventory.paths.length).toBeLessThanOrEqual(3000);
      expect(inventory.pathsComplete).toBe(false);
      expect(picks.length + 2).toBeLessThanOrEqual(MAX_FILES_FETCHED);
    });

    it("keeps the model prompt inside the context window, and says what it did not see", () => {
      const files = picks.map((p) => ({
        path: p.path,
        reason: p.reason,
        text: "const value = compute(1); // filler\n".repeat(4000)
      }));
      const prompt = buildAnalysisPrompt({
        target: { owner: "o", repo: "big", subpath: "" },
        sha: "a".repeat(40),
        facts: [],
        ruleFindings: [],
        files,
        coverage: {
          sourceFilesTotal: inventory.sourceFileCount,
          sourceFilesFetched: files.length,
          neverFetched: [],
          treeTruncated: false,
          skipped: {},
          otherProjects: []
        }
      });
      expect(fitsContext(prompt)).toBe(true);
      expect(prompt.user).toContain(
        "Files you were not shown were not inspected"
      );
      expect(prompt.omitted.length + Object.keys(prompt.shown).length).toBe(
        files.length
      );
      expect(inventoryMs).toBeLessThan(3000); // sanity only; timing varies under load
    });
  });

  it("writes the scorecard", () => {
    mkdirSync(OUT, { recursive: true });
    const rules = [...perRule.entries()]
      .map(([rule, m]) => ({
        rule,
        ...m,
        precision: m.tp + m.fp === 0 ? null : m.tp / (m.tp + m.fp),
        recall: m.tp + m.fn === 0 ? null : m.tp / (m.tp + m.fn)
      }))
      .sort((a, b) => a.rule.localeCompare(b.rule));
    const summary = {
      generatedAt: new Date().toISOString(),
      fixtures: fixtures.length,
      rulesInEngine: RULES.length,
      rulesExercised: rules.filter((r) => r.tp + r.fn > 0).length,
      seededIssues: seeded + seededExtra,
      seededFound: found + seededExtra,
      seededRecall:
        seeded + seededExtra === 0
          ? null
          : (found + seededExtra) / (seeded + seededExtra),
      cleanFixtures: clean.length,
      cleanFixturesWithFindings: cleanWithFindings.length,
      findingsTotal: totalFindings,
      fixtureExactMatch: rows.filter((r) => r.exact).length,
      evidence: {
        items: evidenceItems,
        pathsValid: evidencePathOk,
        withLines: evidenceWithLines,
        linesValid: evidenceLinesOk,
        excerptsConsistent: evidenceExcerptOk,
        excerptsSynthetic: evidenceExcerptSynthetic
      },
      plantedSecretLeaks: secretLeaks,
      oversizedEntries: oversized.entries,
      oversizedInventoryMs: Math.round(oversized.inventoryMs * 10) / 10
    };
    writeFileSync(
      join(OUT, "deterministic.json"),
      `${JSON.stringify({ summary, rules, rows }, null, 2)}\n`
    );

    const table = [
      "| Rule | Expected in | TP | FP | FN | Precision | Recall |",
      "|---|---:|---:|---:|---:|---:|---:|",
      ...rules.map(
        (r) =>
          `| ${r.rule} | ${r.tp + r.fn} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.precision === null ? "n/a" : r.precision.toFixed(2)} | ${r.recall === null ? "n/a" : r.recall.toFixed(2)} |`
      )
    ].join("\n");
    writeFileSync(join(OUT, "deterministic.md"), `${table}\n`);
    expect(summary.seededRecall).toBe(1);
  });
});
