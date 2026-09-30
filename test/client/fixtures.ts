import type {
  AuditDetail,
  Finding,
  Manifest,
  ShipGuardState,
  StageState
} from "../../src/shared/types";
import { STAGE_LABELS, STAGE_ORDER } from "../../src/shared/types";

export const TARGET = {
  owner: "acme",
  repo: "worker",
  ref: "main",
  subpath: ""
};
export const AUDIT_ID = "11111111-2222-4333-8444-555555555555";

export const manifest: Manifest = {
  repo: "acme/worker",
  ref: "main",
  sha: "a".repeat(40),
  filesDiscovered: 12,
  filesSelected: 3,
  filesSkipped: 9,
  treeTruncated: false,
  selected: [
    {
      path: "wrangler.jsonc",
      reason: "Cloudflare deployment configuration",
      chars: 400,
      fetched: true,
      shownToAi: "full"
    },
    {
      path: "src/index.ts",
      reason: "Worker entry point",
      chars: 900,
      fetched: true,
      shownToAi: "partial"
    },
    {
      path: "src/other.ts",
      reason: "Source file",
      chars: 0,
      fetched: false,
      shownToAi: "no",
      error: "GitHub did not answer in time."
    }
  ],
  skipped: { lockfile: 1, "not selected (lower priority)": 8 },
  neverFetched: [".dev.vars"]
};

export const finding = (over: Partial<Finding> = {}): Finding => ({
  fingerprint: "CF_DO_NOT_DECLARED:DeploymentAgent",
  displayId: "F-001",
  ruleId: "CF_DO_NOT_DECLARED",
  source: "rule",
  severity: "high",
  confidence: 0.9,
  category: "durable-objects",
  title: "Durable Object class `DeploymentAgent` is bound but never declared",
  explanation:
    "Binding DEPLOY_AGENT points at DeploymentAgent, but no migration creates it.",
  recommendation: "Add a migration that creates DeploymentAgent.",
  evidence: [
    {
      path: "wrangler.jsonc",
      lineStart: 6,
      lineEnd: 6,
      excerpt: '"class_name": "DeploymentAgent"'
    }
  ],
  docsUrl:
    "https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/",
  ...over
});

export function stages(
  done: number,
  opts: { failedAt?: number } = {}
): StageState[] {
  return STAGE_ORDER.map((id, i) => ({
    id,
    label: STAGE_LABELS[id],
    status: opts.failedAt === i ? "failed" : i < done ? "done" : "pending",
    detail: i < done ? `detail for ${id}` : undefined,
    ms: i < done ? 120 : undefined
  }));
}

export function detail(over: Partial<AuditDetail> = {}): AuditDetail {
  const f = finding();
  return {
    id: AUDIT_ID,
    target: TARGET,
    sha: "a".repeat(40),
    status: "complete",
    aiStatus: "ok",
    createdAt: new Date().toISOString(),
    counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    headline: "1 finding: 1 high",
    summary: "One configuration problem blocks deployment.",
    manifest,
    findings: [f],
    resolved: [],
    changes: { [f.fingerprint]: "new" },
    dispositions: {},
    plan: ["Add the migration.", "Redeploy."],
    stages: stages(8),
    rejectedAiFindings: 0,
    ...over
  };
}

export function state(over: Partial<ShipGuardState> = {}): ShipGuardState {
  return { recent: [], ...over };
}
