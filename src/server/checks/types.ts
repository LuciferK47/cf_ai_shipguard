import type { Finding } from "../../shared/types";
import type { ParsedPackage } from "../config/package";
import type { ParsedTsconfig } from "../config/tsconfig";
import type { ParsedWrangler } from "../config/wrangler";
import type { SecretHit } from "../security/redact";
import type { ScannedSource } from "./source";

/** Everything the rules may look at. Built once per audit, then read-only. */
export interface CheckContext {
  /** Directory treated as the project root ("" for the repository root). */
  base: string;
  /** Fetched file bodies keyed by repository-relative path. */
  files: ReadonlyMap<string, string>;
  /** Existence index for files under the base (includes files never fetched). */
  paths: ReadonlySet<string>;
  /** False when the index is incomplete, so "file is missing" claims are unsafe. */
  pathsComplete: boolean;
  /** Files that were selected but could not be downloaded, with the reason. */
  unread: Readonly<Record<string, string>>;
  /** Secret-bearing files that exist but were deliberately not downloaded. */
  neverFetched: readonly string[];
  otherProjects: readonly string[];
  /** Every Wrangler config found at the base. */
  wranglerConfigs: readonly ParsedWrangler[];
  /** The config the rules reason about (first parseable one). */
  primary?: ParsedWrangler;
  pkg?: ParsedPackage;
  tsconfig?: ParsedTsconfig;
  sources: readonly ScannedSource[];
  /** Secret-shaped matches per file (already redacted). */
  secretHits: Readonly<Record<string, readonly SecretHit[]>>;
  /** How much of the repository's source was actually inspected. */
  coverage: {
    sourcesFetched: number;
    sourcesTotal: number;
    complete: boolean;
  };
}

export interface Rule {
  id: string;
  run(ctx: CheckContext): Finding[];
}

export interface SkippedRule {
  ruleId: string;
  reason: string;
}

export interface CheckResult {
  findings: Finding[];
  rulesRun: string[];
  skipped: SkippedRule[];
}
