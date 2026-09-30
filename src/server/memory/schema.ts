import type { Db } from "./db";

export const SCHEMA_VERSION = 1;

/**
 * Project memory lives in the agent's own SQLite database, next to the chat
 * history that AIChatAgent keeps. State broadcast to clients stays small; these
 * tables hold everything that grows.
 */
export function initSchema(db: Db): void {
  const { sql } = db;
  sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  sql`CREATE TABLE IF NOT EXISTS targets (
    key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    default_branch TEXT,
    next_finding_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    target_key TEXT NOT NULL,
    ref TEXT,
    sha TEXT,
    status TEXT NOT NULL,
    ai_status TEXT NOT NULL DEFAULT 'skipped',
    ai_note TEXT,
    error_code TEXT,
    error_message TEXT,
    headline TEXT,
    summary TEXT,
    plan_json TEXT,
    manifest_json TEXT,
    stats_json TEXT,
    counts_json TEXT,
    previous_audit_id TEXT,
    rejected_ai INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`;
  sql`CREATE INDEX IF NOT EXISTS audits_by_target ON audits (target_key, created_at)`;
  sql`CREATE TABLE IF NOT EXISTS audit_stages (
    audit_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    ms INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (audit_id, stage)
  )`;
  sql`CREATE TABLE IF NOT EXISTS findings (
    audit_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    display_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    category TEXT,
    title TEXT NOT NULL,
    explanation TEXT,
    recommendation TEXT,
    evidence_json TEXT,
    docs_url TEXT,
    change TEXT NOT NULL,
    PRIMARY KEY (audit_id, fingerprint)
  )`;
  sql`CREATE TABLE IF NOT EXISTS finding_ids (
    target_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    display_id TEXT NOT NULL,
    first_audit_id TEXT,
    PRIMARY KEY (target_key, fingerprint)
  )`;
  sql`CREATE TABLE IF NOT EXISTS dispositions (
    target_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_key, fingerprint)
  )`;
  sql`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})`;
}
