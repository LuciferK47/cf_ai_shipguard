import {
  SEVERITY_ORDER,
  STAGE_LABELS,
  STAGE_ORDER,
  emptyCounts,
  type AiStatus,
  type AuditCounts,
  type AuditDetail,
  type AuditError,
  type AuditSummary,
  type Evidence,
  type Finding,
  type FindingChange,
  type FindingStatus,
  type Manifest,
  type Severity,
  type StageId,
  type StageState,
  type StageStatus,
  type Target
} from "../../shared/types";
import { diffFindings } from "../findings/diff";
import { displayId, parseDisplayId } from "../findings/ids";
import { targetKey } from "../github/target";
import { MAX_AUDITS_PER_TARGET } from "../limits";
import type { Db } from "./db";

// All reads and writes to project memory. Every write that a workflow retry
// could repeat is an upsert, and the report is written in one transaction.

interface AuditRow {
  id: string;
  target_key: string;
  ref: string | null;
  sha: string | null;
  status: string;
  ai_status: string;
  ai_note: string | null;
  error_code: string | null;
  error_message: string | null;
  headline: string | null;
  summary: string | null;
  plan_json: string | null;
  manifest_json: string | null;
  counts_json: string | null;
  previous_audit_id: string | null;
  rejected_ai: number;
  created_at: string;
}

interface TargetRow {
  key: string;
  owner: string;
  repo: string;
  subpath: string;
  default_branch: string | null;
  next_finding_number: number;
}

interface FindingRow {
  audit_id: string;
  fingerprint: string;
  display_id: string;
  rule_id: string;
  source: string;
  severity: string;
  confidence: number;
  category: string | null;
  title: string;
  explanation: string | null;
  recommendation: string | null;
  evidence_json: string | null;
  docs_url: string | null;
  change: string;
}

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const SEVERITIES = new Set<string>(SEVERITY_ORDER);

function asSeverity(s: string): Severity {
  return SEVERITIES.has(s) ? (s as Severity) : "info";
}

// ---------------------------------------------------------------- targets

export function upsertTarget(
  db: Db,
  target: Target,
  defaultBranch: string | undefined,
  now: string
): string {
  const key = targetKey(target);
  db.sql`INSERT INTO targets (key, owner, repo, subpath, default_branch, created_at, updated_at)
    VALUES (${key}, ${target.owner}, ${target.repo}, ${target.subpath}, ${defaultBranch ?? null}, ${now}, ${now})
    ON CONFLICT(key) DO UPDATE SET
      default_branch = COALESCE(${defaultBranch ?? null}, targets.default_branch),
      updated_at = ${now}`;
  return key;
}

export function getTarget(
  db: Db,
  key: string
): (Target & { key: string }) | undefined {
  const [row] = db.sql<TargetRow>`SELECT * FROM targets WHERE key = ${key}`;
  return row
    ? { key: row.key, owner: row.owner, repo: row.repo, subpath: row.subpath }
    : undefined;
}

export function listTargets(
  db: Db,
  limit = 10
): Array<Target & { key: string }> {
  return db.sql<TargetRow>`SELECT * FROM targets ORDER BY updated_at DESC LIMIT ${limit}`.map(
    (r) => ({ key: r.key, owner: r.owner, repo: r.repo, subpath: r.subpath })
  );
}

// ----------------------------------------------------------------- audits

export function createAudit(
  db: Db,
  input: { id: string; target: Target; now: string }
): string {
  const key = upsertTarget(db, input.target, undefined, input.now);
  db.transaction(() => {
    db.sql`INSERT OR IGNORE INTO audits (id, target_key, ref, status, created_at)
      VALUES (${input.id}, ${key}, ${input.target.ref ?? null}, 'running', ${input.now})`;
    for (const stage of STAGE_ORDER) {
      db.sql`INSERT OR IGNORE INTO audit_stages (audit_id, stage, status, updated_at)
        VALUES (${input.id}, ${stage}, 'pending', ${input.now})`;
    }
  });
  return key;
}

export function countAuditsSince(db: Db, iso: string): number {
  const [row] = db.sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM audits WHERE created_at >= ${iso}`;
  return row?.n ?? 0;
}

export function getRunningAudits(
  db: Db
): Array<{ id: string; createdAt: string; targetKey: string }> {
  return db.sql<AuditRow>`SELECT id, created_at, target_key FROM audits WHERE status = 'running' ORDER BY created_at`.map(
    (r) => ({ id: r.id, createdAt: r.created_at, targetKey: r.target_key })
  );
}

// ----------------------------------------------------------------- stages

const STAGE_SET = new Set<string>(STAGE_ORDER);

/**
 * Record progress for one stage. Progress only ever moves forward, so a
 * replayed or duplicated workflow report can never regress the timeline:
 * a stage that is already finished is not overwritten, not even by another
 * "done" from a retry.
 */
export function upsertStage(
  db: Db,
  auditId: string,
  stage: string,
  status: StageStatus,
  detail: string | undefined,
  ms: number | undefined,
  now: string
): boolean {
  if (!STAGE_SET.has(stage)) return false;
  db.sql`INSERT INTO audit_stages (audit_id, stage, status, detail, ms, updated_at)
    VALUES (${auditId}, ${stage}, ${status}, ${detail ?? null}, ${ms ?? null}, ${now})
    ON CONFLICT(audit_id, stage) DO UPDATE SET
      status = excluded.status, detail = excluded.detail, ms = excluded.ms, updated_at = excluded.updated_at
    WHERE (CASE audit_stages.status WHEN 'pending' THEN 0 WHEN 'running' THEN 1 ELSE 2 END)
        < (CASE excluded.status WHEN 'pending' THEN 0 WHEN 'running' THEN 1 ELSE 2 END)`;
  return true;
}

export function getStages(db: Db, auditId: string): StageState[] {
  const rows = db.sql<{
    stage: string;
    status: string;
    detail: string | null;
    ms: number | null;
  }>`
    SELECT stage, status, detail, ms FROM audit_stages WHERE audit_id = ${auditId}`;
  const byStage = new Map(rows.map((r) => [r.stage, r]));
  return STAGE_ORDER.map((id) => {
    const r = byStage.get(id);
    return {
      id,
      label: STAGE_LABELS[id],
      status: (r?.status as StageStatus | undefined) ?? "pending",
      detail: r?.detail ?? undefined,
      ms: r?.ms ?? undefined
    };
  });
}

/**
 * Stages as the UI should show them: the first stage that is not finished is
 * "running" while the audit is running. This mirrors what the workflow is
 * actually doing, since it executes the stages strictly in order.
 */
export function stagesForDisplay(
  stages: StageState[],
  auditRunning: boolean
): StageState[] {
  if (!auditRunning) return stages;
  let marked = false;
  return stages.map((s) => {
    if (!marked && s.status === "pending") {
      marked = true;
      return { ...s, status: "running" as const };
    }
    return s;
  });
}

// ---------------------------------------------------------------- reports

export interface PersistInput {
  auditId: string;
  sha: string;
  ref: string;
  defaultBranch?: string;
  findings: Finding[];
  summary: string;
  plan: string[];
  manifest: Manifest;
  aiStatus: AiStatus;
  aiNote?: string;
  rejectedAi: number;
  now: string;
}

export function countBySeverity(
  findings: readonly { severity: Severity }[]
): AuditCounts {
  const counts = emptyCounts();
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function makeHeadline(counts: AuditCounts, total: number): string {
  if (total === 0) return "No findings";
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]} ${s}`
  );
  return `${total} finding${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function rowToSummary(
  row: AuditRow,
  target: TargetRow | undefined
): AuditSummary {
  const counts = safeJson<AuditCounts>(row.counts_json, emptyCounts());
  const error: AuditError | undefined = row.error_code
    ? {
        code: row.error_code as AuditError["code"],
        message: row.error_message ?? ""
      }
    : undefined;
  return {
    id: row.id,
    target: {
      owner: target?.owner ?? "",
      repo: target?.repo ?? "",
      ref: row.ref ?? undefined,
      subpath: target?.subpath ?? ""
    },
    sha: row.sha ?? "",
    status: row.status as AuditSummary["status"],
    aiStatus: row.ai_status as AiStatus,
    createdAt: row.created_at,
    counts,
    headline:
      row.headline ?? (row.status === "running" ? "Audit in progress" : ""),
    error
  };
}

function getAuditRow(db: Db, id: string): AuditRow | undefined {
  return db.sql<AuditRow>`SELECT * FROM audits WHERE id = ${id}`[0];
}

function getTargetRow(db: Db, key: string): TargetRow | undefined {
  return db.sql<TargetRow>`SELECT * FROM targets WHERE key = ${key}`[0];
}

export function getAuditSummary(db: Db, id: string): AuditSummary | undefined {
  const row = getAuditRow(db, id);
  return row ? rowToSummary(row, getTargetRow(db, row.target_key)) : undefined;
}

/**
 * Store a finished report. Safe to call twice for the same audit: a completed
 * audit is returned unchanged, and every write inside is an upsert. Finding
 * display ids (F-001, ...) are assigned per target and reused across audits.
 */
export function persistReport(db: Db, input: PersistInput): AuditSummary {
  return db.transaction(() => {
    const audit = getAuditRow(db, input.auditId);
    if (!audit) throw new Error(`Unknown audit ${input.auditId}`);
    if (audit.status === "complete") {
      return rowToSummary(audit, getTargetRow(db, audit.target_key));
    }
    const key = audit.target_key;

    const [prev] = db.sql<{ id: string }>`SELECT id FROM audits
      WHERE target_key = ${key} AND status = 'complete' AND id != ${input.auditId}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const previousFindings = prev
      ? db.sql<{
          fingerprint: string;
        }>`SELECT fingerprint FROM findings WHERE audit_id = ${prev.id}`
      : undefined;
    const diff = diffFindings(previousFindings, input.findings);

    for (const f of input.findings) {
      let [idRow] = db.sql<{
        display_id: string;
      }>`SELECT display_id FROM finding_ids
        WHERE target_key = ${key} AND fingerprint = ${f.fingerprint}`;
      if (!idRow) {
        const [t] = db.sql<{
          next_finding_number: number;
        }>`SELECT next_finding_number FROM targets WHERE key = ${key}`;
        const n = t?.next_finding_number ?? 1;
        idRow = { display_id: displayId(n) };
        db.sql`INSERT INTO finding_ids (target_key, fingerprint, display_id, first_audit_id)
          VALUES (${key}, ${f.fingerprint}, ${idRow.display_id}, ${input.auditId})`;
        db.sql`UPDATE targets SET next_finding_number = ${n + 1} WHERE key = ${key}`;
      }
      db.sql`INSERT OR REPLACE INTO findings
        (audit_id, fingerprint, display_id, rule_id, source, severity, confidence, category, title,
         explanation, recommendation, evidence_json, docs_url, change)
        VALUES (${input.auditId}, ${f.fingerprint}, ${idRow.display_id}, ${f.ruleId}, ${f.source},
          ${f.severity}, ${f.confidence}, ${f.category}, ${f.title}, ${f.explanation},
          ${f.recommendation}, ${JSON.stringify(f.evidence)}, ${f.docsUrl ?? null},
          ${diff.changes[f.fingerprint] ?? "new"})`;
    }

    const counts = countBySeverity(input.findings);
    db.sql`UPDATE audits SET
        status = 'complete', ref = ${input.ref}, sha = ${input.sha},
        ai_status = ${input.aiStatus}, ai_note = ${input.aiNote ?? null},
        headline = ${makeHeadline(counts, input.findings.length)},
        summary = ${input.summary}, plan_json = ${JSON.stringify(input.plan)},
        manifest_json = ${JSON.stringify(input.manifest)}, counts_json = ${JSON.stringify(counts)},
        previous_audit_id = ${prev?.id ?? null}, rejected_ai = ${input.rejectedAi},
        error_code = NULL, error_message = NULL, completed_at = ${input.now}
      WHERE id = ${input.auditId}`;
    db.sql`UPDATE targets SET
        default_branch = COALESCE(${input.defaultBranch ?? null}, default_branch), updated_at = ${input.now}
      WHERE key = ${key}`;

    const done = getAuditRow(db, input.auditId);
    if (!done) throw new Error("Audit vanished during persist");
    return rowToSummary(done, getTargetRow(db, key));
  });
}

export function failAudit(
  db: Db,
  id: string,
  error: AuditError,
  now: string
): void {
  db.transaction(() => {
    const audit = getAuditRow(db, id);
    if (!audit || audit.status !== "running") return;
    db.sql`UPDATE audits SET status = 'failed', error_code = ${error.code},
        error_message = ${error.message}, headline = 'Audit failed', completed_at = ${now}
      WHERE id = ${id}`;
    // The first unfinished stage is the one that failed.
    const stages = getStages(db, id);
    const failing = stages.find(
      (s) => s.status === "pending" || s.status === "running"
    );
    if (failing)
      upsertStage(
        db,
        id,
        failing.id,
        "failed",
        error.message.slice(0, 200),
        undefined,
        now
      );
  });
}

// --------------------------------------------------------------- readback

function rowToFinding(row: FindingRow): Finding {
  return {
    fingerprint: row.fingerprint,
    displayId: row.display_id,
    ruleId: row.rule_id,
    source: row.source === "ai" ? "ai" : "rule",
    severity: asSeverity(row.severity),
    confidence: row.confidence,
    category: row.category ?? "",
    title: row.title,
    explanation: row.explanation ?? "",
    recommendation: row.recommendation ?? "",
    evidence: safeJson<Evidence[]>(row.evidence_json, []),
    docsUrl: row.docs_url ?? undefined
  };
}

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      (a.displayId ?? "").localeCompare(b.displayId ?? "")
  );
}

export function getFindings(db: Db, auditId: string): Finding[] {
  return sortFindings(
    db.sql<FindingRow>`SELECT * FROM findings WHERE audit_id = ${auditId}`.map(
      rowToFinding
    )
  );
}

export function getDispositions(
  db: Db,
  key: string
): Record<string, { status: FindingStatus; note?: string }> {
  const rows = db.sql<{
    fingerprint: string;
    status: string;
    note: string | null;
  }>`
    SELECT fingerprint, status, note FROM dispositions WHERE target_key = ${key}`;
  const out: Record<string, { status: FindingStatus; note?: string }> = {};
  for (const r of rows)
    out[r.fingerprint] = {
      status: r.status as FindingStatus,
      note: r.note ?? undefined
    };
  return out;
}

export function getAuditDetail(db: Db, id: string): AuditDetail | undefined {
  const row = getAuditRow(db, id);
  if (!row) return undefined;
  const summary = rowToSummary(row, getTargetRow(db, row.target_key));
  const rows = db.sql<FindingRow>`SELECT * FROM findings WHERE audit_id = ${id}`;
  const findings = sortFindings(rows.map(rowToFinding));

  const changes: Record<string, FindingChange> = {};
  for (const r of rows)
    changes[r.fingerprint] = r.change === "persisting" ? "persisting" : "new";

  let resolved: Finding[] = [];
  if (row.previous_audit_id) {
    const current = new Set(rows.map((r) => r.fingerprint));
    const before = db.sql<FindingRow>`SELECT * FROM findings WHERE audit_id = ${row.previous_audit_id}`;
    resolved = sortFindings(
      before.filter((r) => !current.has(r.fingerprint)).map(rowToFinding)
    );
    for (const f of resolved) changes[f.fingerprint] = "resolved";
  }

  const dispositions = getDispositions(db, row.target_key);
  const running = row.status === "running";
  return {
    ...summary,
    aiNote: row.ai_note ?? undefined,
    manifest: safeJson<Manifest>(row.manifest_json, {
      repo: "",
      ref: "",
      sha: "",
      filesDiscovered: 0,
      filesSelected: 0,
      filesSkipped: 0,
      treeTruncated: false,
      selected: [],
      skipped: {},
      neverFetched: []
    }),
    findings,
    resolved,
    changes,
    dispositions,
    plan: safeJson<string[]>(row.plan_json, []),
    stages: stagesForDisplay(getStages(db, id), running),
    previousAuditId: row.previous_audit_id ?? undefined,
    rejectedAiFindings: row.rejected_ai
  };
}

export function listAuditSummaries(
  db: Db,
  opts: { limit: number; targetKey?: string }
): AuditSummary[] {
  const rows = opts.targetKey
    ? db.sql<AuditRow>`SELECT * FROM audits WHERE target_key = ${opts.targetKey}
        ORDER BY created_at DESC, rowid DESC LIMIT ${opts.limit}`
    : db.sql<AuditRow>`SELECT * FROM audits ORDER BY created_at DESC, rowid DESC LIMIT ${opts.limit}`;
  return rows.map((r) => rowToSummary(r, getTargetRow(db, r.target_key)));
}

export function latestCompleteAudit(
  db: Db,
  key: string
): AuditSummary | undefined {
  const [row] =
    db.sql<AuditRow>`SELECT * FROM audits WHERE target_key = ${key} AND status = 'complete'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`;
  return row ? rowToSummary(row, getTargetRow(db, key)) : undefined;
}

// ----------------------------------------------------------- dispositions

/** Resolve "F-003" (or a fingerprint) to a fingerprint for this target. */
export function resolveFingerprint(
  db: Db,
  key: string,
  ref: string
): string | undefined {
  const display = parseDisplayId(ref);
  if (display) {
    const [row] = db.sql<{
      fingerprint: string;
    }>`SELECT fingerprint FROM finding_ids
      WHERE target_key = ${key} AND display_id = ${display}`;
    return row?.fingerprint;
  }
  const [row] = db.sql<{
    fingerprint: string;
  }>`SELECT fingerprint FROM finding_ids
    WHERE target_key = ${key} AND fingerprint = ${ref}`;
  return row?.fingerprint;
}

export function setDisposition(
  db: Db,
  key: string,
  ref: string,
  status: FindingStatus,
  note: string | undefined,
  now: string
): boolean {
  const fingerprint = resolveFingerprint(db, key, ref);
  if (!fingerprint) return false;
  if (status === "open") {
    db.sql`DELETE FROM dispositions WHERE target_key = ${key} AND fingerprint = ${fingerprint}`;
    return true;
  }
  db.sql`INSERT INTO dispositions (target_key, fingerprint, status, note, updated_at)
    VALUES (${key}, ${fingerprint}, ${status}, ${note ?? null}, ${now})
    ON CONFLICT(target_key, fingerprint) DO UPDATE SET
      status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`;
  return true;
}

// ---------------------------------------------------------------- pruning

/** Keep the newest audits for a target; returns the ids that were removed. */
export function pruneAudits(
  db: Db,
  key: string,
  keep: number = MAX_AUDITS_PER_TARGET
): string[] {
  return db.transaction(() => {
    const old = db.sql<{
      id: string;
    }>`SELECT id FROM audits WHERE target_key = ${key} AND status != 'running'
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${keep}`;
    for (const { id } of old) {
      db.sql`DELETE FROM findings WHERE audit_id = ${id}`;
      db.sql`DELETE FROM audit_stages WHERE audit_id = ${id}`;
      db.sql`DELETE FROM audits WHERE id = ${id}`;
    }
    return old.map((o) => o.id);
  });
}

// -------------------------------------------------------- memory for chat

export interface HistoryEntry {
  auditId: string;
  ref?: string;
  sha: string;
  createdAt: string;
  present: boolean;
}

export interface MemoryView {
  target?: Target & { key: string };
  /** Newest first. */
  audits: AuditSummary[];
  latest?: AuditDetail;
  /** Presence of each finding (by display id) across recent audits, newest first. */
  history: Record<string, HistoryEntry[]>;
}

const HISTORY_AUDITS = 5;

export function loadMemoryView(db: Db, key: string | undefined): MemoryView {
  if (!key) return { audits: [], history: {} };
  const target = getTarget(db, key);
  const audits = listAuditSummaries(db, {
    limit: HISTORY_AUDITS,
    targetKey: key
  }).filter((a) => a.status === "complete");
  const latest = audits[0] ? getAuditDetail(db, audits[0].id) : undefined;

  const history: Record<string, HistoryEntry[]> = {};
  if (audits.length > 0) {
    const ids = db.sql<{ fingerprint: string; display_id: string }>`
      SELECT fingerprint, display_id FROM finding_ids WHERE target_key = ${key}`;
    const presence = new Map<string, Set<string>>();
    for (const a of audits) {
      const rows = db.sql<{
        fingerprint: string;
      }>`SELECT fingerprint FROM findings WHERE audit_id = ${a.id}`;
      presence.set(a.id, new Set(rows.map((r) => r.fingerprint)));
    }
    for (const { fingerprint, display_id } of ids) {
      history[display_id] = audits.map((a) => ({
        auditId: a.id,
        ref: a.target.ref,
        sha: a.sha,
        createdAt: a.createdAt,
        present: presence.get(a.id)?.has(fingerprint) ?? false
      }));
    }
  }
  return { target, audits, latest, history };
}
