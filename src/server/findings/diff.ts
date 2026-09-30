import type { FindingChange } from "../../shared/types";

export interface Diff {
  /** For each current fingerprint: new, or persisting from the previous audit. */
  changes: Record<string, Exclude<FindingChange, "resolved">>;
  /** Fingerprints that were in the previous audit and are no longer present. */
  resolved: string[];
}

/**
 * Compare two audits of the same target by finding fingerprint. Rule findings
 * have stable fingerprints, so a persisting finding is genuinely the same
 * issue. Model-written findings are fingerprinted from their title and may not
 * match across audits; they are labelled as such in the UI.
 */
export function diffFindings(
  previous: readonly { fingerprint: string }[] | undefined,
  current: readonly { fingerprint: string }[]
): Diff {
  const prev = new Set((previous ?? []).map((f) => f.fingerprint));
  const cur = new Set(current.map((f) => f.fingerprint));
  const changes: Diff["changes"] = {};
  for (const f of current)
    changes[f.fingerprint] = prev.has(f.fingerprint) ? "persisting" : "new";
  const resolved = previous ? [...prev].filter((fp) => !cur.has(fp)) : [];
  return { changes, resolved };
}
