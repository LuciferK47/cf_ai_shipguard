import { SEVERITY_ORDER, type Finding } from "../../shared/types";
import { aiBindingMissing, classNotExported } from "./bindings";
import {
  doConfigMixed,
  doDeletedButBound,
  doDuplicateTag,
  doKvStorage,
  doNotDeclared
} from "./durable-objects";
import { deployScriptConfigMissing, tsconfigDecorators } from "./package";
import { envFileCommitted, secretPattern } from "./secrets";
import type { CheckContext, CheckResult, Rule } from "./types";
import {
  compatDateMissing,
  configNotFound,
  configParseError,
  configUnreadable,
  envNotInherited,
  mainNotFound,
  nodejsCompatMissing,
  secretInVars
} from "./wrangler";

export const RULES: readonly Rule[] = [
  configNotFound,
  configUnreadable,
  configParseError,
  compatDateMissing,
  mainNotFound,
  envNotInherited,
  nodejsCompatMissing,
  secretInVars,
  doNotDeclared,
  doConfigMixed,
  doKvStorage,
  doDeletedButBound,
  doDuplicateTag,
  classNotExported,
  aiBindingMissing,
  secretPattern,
  envFileCommitted,
  deployScriptConfigMissing,
  tsconfigDecorators
];

/** Run every rule. A rule that throws is reported, never allowed to abort the audit. */
export function runChecks(
  ctx: CheckContext,
  rules: readonly Rule[] = RULES
): CheckResult {
  const findings: Finding[] = [];
  const rulesRun: string[] = [];
  const skipped: CheckResult["skipped"] = [];

  for (const rule of rules) {
    try {
      findings.push(...rule.run(ctx));
      rulesRun.push(rule.id);
    } catch (err) {
      skipped.push({
        ruleId: rule.id,
        reason:
          err instanceof Error ? err.message.slice(0, 200) : "unknown error"
      });
    }
  }

  // De-duplicate on fingerprint (a rule may find the same subject twice).
  const unique = new Map<string, Finding>();
  for (const f of findings)
    if (!unique.has(f.fingerprint)) unique.set(f.fingerprint, f);

  const sorted = [...unique.values()].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint)
  );
  return { findings: sorted, rulesRun, skipped };
}
