import type { Evidence, Finding, Severity } from "../../shared/types";
import { redactSecrets } from "../security/redact";
import type { AiAnalysis, AiFindingRaw } from "./schemas";
import type { ShownFile } from "./prompts";

// Model output is a claim, not a fact. Every piece of evidence is checked
// against the files the model was actually shown before it reaches the report.

export interface VerifyInput {
  raw: AiAnalysis;
  shown: Readonly<Record<string, ShownFile>>;
  files: ReadonlyMap<string, string>;
  ruleFindings: readonly Finding[];
  /** "R1" -> fingerprint of the rule finding it names. */
  refs: Readonly<Record<string, string>>;
}

export interface VerifyStats {
  proposed: number;
  accepted: number;
  rejectedNoEvidence: number;
  duplicates: number;
  evidenceItems: number;
  evidenceAccepted: number;
  /** Evidence whose path was not among the files shown to the model. */
  invalidPaths: number;
  /** Evidence whose line range was outside the shown window and could not be repaired. */
  invalidLines: number;
  /** Excerpts that did not appear in the cited lines. */
  excerptMismatches: number;
  invalidRefs: number;
}

export interface VerifyResult {
  summary: string;
  plan: string[];
  priorities: Array<{ fingerprint: string; why: string }>;
  findings: Finding[];
  stats: VerifyStats;
}

const AI_SEVERITY_CAP: Severity = "high";
const AI_CONFIDENCE_CAP = 0.85;
const LINE_SLACK = 3;

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripControl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += s[i];
  }
  return out;
}

/** Strip control characters (keeping newlines and tabs), redact secrets, cap length. */
function clean(s: string, max: number): string {
  return redactSecrets(stripControl(s)).trim().slice(0, max);
}

/** Like `clean`, but keeps leading indentation so code excerpts stay readable. */
function cleanCode(s: string, max: number): string {
  return redactSecrets(stripControl(s))
    .replace(/^\n+/, "")
    .trimEnd()
    .slice(0, max);
}

/** Small stable hash for fingerprints of model-written findings. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2)
  );
}

function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

function overlaps(a: Evidence, b: Evidence): boolean {
  if (
    a.path !== b.path ||
    a.lineStart === undefined ||
    b.lineStart === undefined
  )
    return false;
  const aEnd = a.lineEnd ?? a.lineStart;
  const bEnd = b.lineEnd ?? b.lineStart;
  return a.lineStart <= bEnd && b.lineStart <= aEnd;
}

interface EvidenceOutcome {
  evidence?: Evidence;
  reason?: "path" | "lines";
  excerptMismatch: boolean;
  pathOnly: boolean;
}

function verifyEvidence(
  e: AiFindingRaw["evidence"][number],
  shown: VerifyInput["shown"],
  files: VerifyInput["files"]
): EvidenceOutcome {
  const path = normalizePath(e.path);
  const window = shown[path];
  const text = files.get(path);
  if (!window || text === undefined) {
    return { reason: "path", excerptMismatch: false, pathOnly: false };
  }
  const lines = text.split("\n");
  const inWindow = (n: number) => n >= window.lineStart && n <= window.lineEnd;
  const excerpt = e.excerpt ? collapse(e.excerpt) : "";
  let excerptMismatch = false;

  // Locate an excerpt within the shown window, to repair wrong line numbers or
  // to supply missing ones. The first few words are matched against single
  // lines; an ambiguous match is treated as not found.
  const probe = excerpt.split(" ").slice(0, 8).join(" ");
  const locate = (): number | undefined => {
    if (probe.length < 8) return undefined;
    let found: number | undefined;
    for (let n = window.lineStart; n <= window.lineEnd; n++) {
      if (collapse(lines[n - 1] ?? "").includes(probe)) {
        if (found !== undefined) return undefined;
        found = n;
      }
    }
    return found;
  };

  let start = e.lineStart;
  let end = e.lineEnd ?? e.lineStart;

  if (start !== undefined && !inWindow(start)) {
    const relocated = locate();
    if (relocated === undefined)
      return { reason: "lines", excerptMismatch: false, pathOnly: false };
    end = relocated + Math.max(0, (end ?? start) - start);
    start = relocated;
  }
  if (start === undefined && excerpt) {
    const relocated = locate();
    if (relocated !== undefined) {
      start = relocated;
      end = relocated;
    }
  }

  if (start === undefined) {
    // Path is real and shown, but no line could be verified.
    return {
      evidence: { path },
      excerptMismatch: excerpt.length > 0,
      pathOnly: true
    };
  }

  end = Math.min(Math.max(end ?? start, start), window.lineEnd, start + 5);

  if (excerpt) {
    const from = Math.max(window.lineStart, start - LINE_SLACK);
    const to = Math.min(window.lineEnd, end + LINE_SLACK);
    const region = collapse(lines.slice(from - 1, to).join(" "));
    if (!region.includes(excerpt.slice(0, 120))) excerptMismatch = true;
  }

  const real = lines
    .slice(start - 1, end)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
  return {
    evidence: {
      path,
      lineStart: start,
      lineEnd: end,
      excerpt: cleanCode(real, 240)
    },
    excerptMismatch,
    pathOnly: false
  };
}

export function verifyAnalysis(input: VerifyInput): VerifyResult {
  const stats: VerifyStats = {
    proposed: input.raw.findings.length,
    accepted: 0,
    rejectedNoEvidence: 0,
    duplicates: 0,
    evidenceItems: 0,
    evidenceAccepted: 0,
    invalidPaths: 0,
    invalidLines: 0,
    excerptMismatches: 0,
    invalidRefs: 0
  };

  const ruleEvidence = input.ruleFindings.flatMap((f) => f.evidence);
  const accepted = new Map<string, Finding>();

  for (const raw of input.raw.findings) {
    const evidence: Evidence[] = [];
    let mismatches = 0;
    let pathOnlyCount = 0;
    for (const e of raw.evidence) {
      stats.evidenceItems++;
      const r = verifyEvidence(e, input.shown, input.files);
      if (r.excerptMismatch) {
        mismatches++;
        stats.excerptMismatches++;
      }
      if (!r.evidence) {
        if (r.reason === "path") stats.invalidPaths++;
        else stats.invalidLines++;
        continue;
      }
      if (r.pathOnly) pathOnlyCount++;
      stats.evidenceAccepted++;
      evidence.push(r.evidence);
    }

    if (evidence.length === 0) {
      stats.rejectedNoEvidence++;
      continue;
    }

    const title = clean(raw.title, 160);
    const duplicate =
      input.ruleFindings.some((f) => similar(f.title, title)) ||
      evidence.some((e) => ruleEvidence.some((r) => overlaps(e, r)));
    if (duplicate) {
      stats.duplicates++;
      continue;
    }

    let confidence = Math.min(raw.confidence, AI_CONFIDENCE_CAP);
    if (mismatches > 0) confidence *= 0.8;
    if (pathOnlyCount === evidence.length) confidence *= 0.85;

    const severity: Severity =
      raw.severity === "critical" ? AI_SEVERITY_CAP : raw.severity;
    const fingerprint = `AI:${fnv1a(`${collapse(title).toLowerCase()}|${evidence[0].path}`)}`;
    if (accepted.has(fingerprint)) {
      stats.duplicates++;
      continue;
    }
    accepted.set(fingerprint, {
      fingerprint,
      ruleId: "AI_ANALYSIS",
      source: "ai",
      severity,
      confidence: Math.round(confidence * 100) / 100,
      category: clean(raw.category, 40) || "analysis",
      title,
      explanation: clean(raw.explanation, 900),
      recommendation: clean(raw.recommendation, 600),
      evidence
    });
    stats.accepted++;
  }

  const priorities: VerifyResult["priorities"] = [];
  const seen = new Set<string>();
  for (const p of input.raw.priorities) {
    const fingerprint = input.refs[p.ref.trim().toUpperCase()];
    if (!fingerprint || seen.has(fingerprint)) {
      if (!fingerprint) stats.invalidRefs++;
      continue;
    }
    seen.add(fingerprint);
    priorities.push({ fingerprint, why: clean(p.why, 300) });
  }

  return {
    summary: clean(input.raw.summary, 700),
    plan: input.raw.plan.map((s) => clean(s, 300)).filter((s) => s.length > 0),
    priorities,
    findings: [...accepted.values()],
    stats
  };
}
