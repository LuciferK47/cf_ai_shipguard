import { findSecrets, type SecretHit } from "../security/redact";
import { scanSource, type ScannedSource } from "./source";

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

export interface ScanResult {
  sources: ScannedSource[];
  /** Redacted secret-shaped matches per file path. */
  secretHits: Record<string, SecretHit[]>;
}

/**
 * Characters scanned per Workflow step. Scanning is the CPU-heavy part of
 * static analysis, and the Free plan allows 10 ms of CPU per step, so the work
 * is split into batches that each stay well below that.
 */
export const SCAN_BATCH_CHARS = 60_000;

/** Group file paths into batches of at most `maxChars`; an oversized file gets its own. */
export function planScanBatches(
  files: ReadonlyMap<string, string>,
  maxChars: number = SCAN_BATCH_CHARS
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const [path, text] of files) {
    if (current.length > 0 && used + text.length > maxChars) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(path);
    used += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Scan the given files once. The result is small and serialisable (no file
 * text), so it can be the return value of its own Workflow step.
 */
export function scanFiles(
  files: ReadonlyMap<string, string>,
  paths: readonly string[] = [...files.keys()]
): ScanResult {
  const sources: ScannedSource[] = [];
  const secretHits: Record<string, SecretHit[]> = {};
  for (const path of paths) {
    const text = files.get(path);
    if (text === undefined) continue;
    if (CODE_EXT.test(path)) sources.push(scanSource(path, text));
    const hits = findSecrets(text);
    if (hits.length > 0) secretHits[path] = hits;
  }
  return { sources, secretHits };
}

export function mergeScans(results: readonly ScanResult[]): ScanResult {
  return {
    sources: results.flatMap((r) => r.sources),
    secretHits: Object.assign({}, ...results.map((r) => r.secretHits))
  };
}
