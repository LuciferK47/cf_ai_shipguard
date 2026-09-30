import {
  SEVERITY_ORDER,
  type AuditCounts,
  type Finding
} from "../../shared/types";
import { makeHeadline } from "../memory/store";

/**
 * Order findings by severity, then by the model's stated priority (if any),
 * then by their original order. The model can reorder within a severity but
 * can never demote a critical finding below a low one.
 */
export function mergeAndRank(
  ruleFindings: readonly Finding[],
  aiFindings: readonly Finding[],
  priorities: ReadonlyArray<{ fingerprint: string }>
): Finding[] {
  const rank = new Map(priorities.map((p, i) => [p.fingerprint, i]));
  const all = [...ruleFindings, ...aiFindings];
  const seen = new Set<string>();
  const unique = all.filter((f) =>
    seen.has(f.fingerprint) ? false : (seen.add(f.fingerprint), true)
  );
  return unique
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.f.severity) -
          SEVERITY_ORDER.indexOf(b.f.severity) ||
        (rank.get(a.f.fingerprint) ?? 99) - (rank.get(b.f.fingerprint) ?? 99) ||
        a.i - b.i
    )
    .map((x) => x.f);
}

/** Fallback remediation plan built from the findings themselves (no model). */
export function derivePlan(findings: readonly Finding[]): string[] {
  return findings
    .filter((f) => f.severity !== "info")
    .slice(0, 5)
    .map((f) => `${f.title}: ${f.recommendation}`.slice(0, 300));
}

/** A summary sentence assembled from counts, used when no model summary exists. */
export function deterministicSummary(
  findings: readonly Finding[],
  counts: AuditCounts
): string {
  if (findings.length === 0) {
    return "No issues were found by the deterministic rules in the files that were inspected.";
  }
  return `${makeHeadline(counts, findings.length)}. These come from deterministic rules applied to the files that were inspected.`;
}
