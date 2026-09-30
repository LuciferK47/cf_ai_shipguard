import type {
  AiStatus,
  AuditError,
  Finding,
  Manifest,
  StageId,
  StageStatus,
  Target
} from "../../shared/types";

/** Parameters the agent passes to the workflow. */
export interface AuditParams {
  auditId: string;
  target: Target;
}

/** One progress report from the workflow: a stage that has really finished. */
export interface StageProgress {
  stage: StageId;
  status: StageStatus;
  detail?: string;
  /** Measured wall time of the work behind this stage. */
  ms?: number;
}

export function isStageProgress(v: unknown): v is StageProgress {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.stage === "string" &&
    typeof p.status === "string" &&
    (p.detail === undefined || typeof p.detail === "string") &&
    (p.ms === undefined || typeof p.ms === "number")
  );
}

/** What the workflow hands to the agent to store as the finished report. */
export interface PersistAuditInput {
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
  persistMs: number;
}

export type { AuditError };
