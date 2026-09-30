// Types shared by the Worker (server) and the React client.
// Keep this file free of runtime imports so both sides can use it.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info"
];

export type FindingSource = "rule" | "ai";

export interface Evidence {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt?: string;
}

export interface Finding {
  /** Stable across audits of the same target: hash of rule + subject. */
  fingerprint: string;
  /** Per-target display id such as F-003. Assigned when the report is stored. */
  displayId?: string;
  ruleId: string;
  source: FindingSource;
  severity: Severity;
  /** 0..1 */
  confidence: number;
  category: string;
  title: string;
  explanation: string;
  recommendation: string;
  evidence: Evidence[];
  docsUrl?: string;
}

export type FindingChange = "new" | "persisting" | "resolved";

export type FindingStatus = "open" | "accepted" | "dismissed";

export type StageId =
  | "resolve"
  | "tree"
  | "config"
  | "sources"
  | "static"
  | "ai"
  | "verify"
  | "persist";

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  /** Human-readable result such as "9 files selected". */
  detail?: string;
  /** Measured wall time for the stage. */
  ms?: number;
}

export const STAGE_LABELS: Record<StageId, string> = {
  resolve: "Repository resolved",
  tree: "File tree retrieved",
  config: "Configuration files fetched",
  sources: "Source files selected and fetched",
  static: "Static configuration checks",
  ai: "AI reasoning (Workers AI)",
  verify: "Findings verified against evidence",
  persist: "Report persisted"
};

export const STAGE_ORDER: readonly StageId[] = [
  "resolve",
  "tree",
  "config",
  "sources",
  "static",
  "ai",
  "verify",
  "persist"
];

export type AiStatus = "ok" | "cached" | "skipped" | "failed";

export type AuditStatus = "running" | "complete" | "failed";

export type ErrorCode =
  | "INVALID_URL"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "GITHUB_UNAVAILABLE"
  | "NO_FILES"
  | "REPO_TOO_LARGE"
  | "AI_UNAVAILABLE"
  | "AI_INVALID_OUTPUT"
  | "LIMIT_REACHED"
  | "WORKFLOW_FAILED"
  | "STALE";

export interface AuditError {
  code: ErrorCode;
  message: string;
}

export interface Target {
  owner: string;
  repo: string;
  /** Requested branch, tag or SHA. Undefined means the default branch. */
  ref?: string;
  /** Directory inside the repository, without leading or trailing slash. */
  subpath: string;
}

export type ShownToAi = "full" | "partial" | "no";

export interface ManifestEntry {
  path: string;
  reason: string;
  /** Characters retrieved (0 if the fetch failed). */
  chars: number;
  fetched: boolean;
  shownToAi: ShownToAi;
  error?: string;
}

export interface Manifest {
  repo: string;
  ref: string;
  sha: string;
  filesDiscovered: number;
  filesSelected: number;
  filesSkipped: number;
  treeTruncated: boolean;
  selected: ManifestEntry[];
  /** Why files were skipped, as counts per reason. */
  skipped: Record<string, number>;
  /** Paths that exist but were deliberately never fetched (for example .env). */
  neverFetched: string[];
}

export interface AuditCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface AuditSummary {
  id: string;
  target: Target;
  sha: string;
  status: AuditStatus;
  aiStatus: AiStatus;
  createdAt: string;
  counts: AuditCounts;
  headline: string;
  error?: AuditError;
}

export interface AuditDetail extends AuditSummary {
  aiNote?: string;
  manifest: Manifest;
  findings: Finding[];
  /** Findings present in the previous audit of this target but not in this one. */
  resolved: Finding[];
  /** Change of each finding fingerprint relative to the previous audit. */
  changes: Record<string, FindingChange>;
  dispositions: Record<string, { status: FindingStatus; note?: string }>;
  plan: string[];
  stages: StageState[];
  previousAuditId?: string;
  rejectedAiFindings: number;
}

/** Small synchronized state broadcast to every connected client. */
export interface ShipGuardState {
  activeTarget?: Target;
  running?: {
    auditId: string;
    target: Target;
    startedAt: string;
    stages: StageState[];
  };
  recent: AuditSummary[];
  watch?: { target: Target; enabled: boolean };
}

export const EMPTY_STATE: ShipGuardState = { recent: [] };

export function emptyCounts(): AuditCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

export function newStages(): StageState[] {
  return STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: "pending"
  }));
}
