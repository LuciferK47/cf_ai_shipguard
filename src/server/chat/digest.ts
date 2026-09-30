import type {
  AuditDetail,
  AuditSummary,
  Finding,
  FindingChange
} from "../../shared/types";
import { findDisplayIds } from "../findings/ids";
import type { MemoryView } from "../memory/store";

// The memory digest is what grounds a chat answer. It is assembled by code from
// stored audits, so the model can only say what ShipGuard actually recorded.
// Excerpts inside it are repository text and are labelled untrusted.

const MAX_DIGEST_CHARS = 7000;
const MAX_DETAILED = 3;

const STOPWORDS = new Set([
  "what",
  "which",
  "that",
  "this",
  "with",
  "have",
  "were",
  "was",
  "did",
  "does",
  "the",
  "and",
  "for",
  "you",
  "your",
  "found",
  "find",
  "issue",
  "issues",
  "problem",
  "problems",
  "earlier",
  "before",
  "previous",
  "still",
  "again",
  "about",
  "tell",
  "show",
  "explain",
  "there",
  "from",
  "when",
  "how",
  "why",
  "fix",
  "fixed",
  "same",
  "last",
  "time",
  "audit",
  "audits",
  "finding",
  "findings"
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function label(a: AuditSummary): string {
  const ref = a.target.ref ?? "default branch";
  const ai =
    a.aiStatus === "failed"
      ? " (AI unavailable)"
      : a.aiStatus === "skipped"
        ? " (no AI)"
        : "";
  return `audit ${shortId(a.id)} on ${ref} @ ${a.sha.slice(0, 7)}, ${a.createdAt.slice(0, 16).replace("T", " ")}Z, ${a.headline}${ai}`;
}

function where(f: Finding): string {
  const e = f.evidence[0];
  if (!e) return "no file evidence";
  return e.lineStart
    ? `${e.path}:${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}`
    : e.path;
}

function summaryLine(
  f: Finding,
  change: FindingChange | undefined,
  disposition?: { status: string; note?: string }
): string {
  const parts = [`${f.displayId} [${f.severity}] ${f.title}`, where(f)];
  if (f.source === "ai") parts.push("AI-suggested");
  if (change) parts.push(change);
  if (disposition)
    parts.push(
      `${disposition.status}${disposition.note ? ` (${disposition.note})` : ""}`
    );
  return `- ${parts.join(" — ")}`;
}

function detailBlock(f: Finding, view: MemoryView): string {
  const lines = [
    `DETAIL ${f.displayId}: ${f.title}`,
    `  rule: ${f.ruleId}; severity: ${f.severity}; confidence: ${f.confidence}`
  ];
  lines.push(`  why it matters: ${f.explanation}`);
  lines.push(`  suggested fix: ${f.recommendation}`);
  for (const e of f.evidence.slice(0, 2)) {
    const loc = e.lineStart ? `${e.path}:${e.lineStart}` : e.path;
    lines.push(
      `  evidence ${loc}${e.excerpt ? ` (untrusted excerpt): ${e.excerpt.replace(/\s+/g, " ").slice(0, 160)}` : ""}`
    );
  }
  const history = f.displayId ? view.history[f.displayId] : undefined;
  if (history && history.length > 0) {
    const h = history
      .map(
        (x) =>
          `${x.ref ?? "default"}@${x.sha.slice(0, 7)}: ${x.present ? "present" : "absent"}`
      )
      .join("; ");
    lines.push(`  across recent audits (newest first): ${h}`);
  }
  return lines.join("\n");
}

function pickDetailed(
  message: string,
  latest: AuditDetail,
  view: MemoryView
): Finding[] {
  const all = [...latest.findings, ...latest.resolved];
  const byId = new Map(all.map((f) => [f.displayId, f]));
  const picked: Finding[] = [];
  const add = (f: Finding | undefined) => {
    if (f && !picked.includes(f) && picked.length < MAX_DETAILED)
      picked.push(f);
  };

  for (const id of findDisplayIds(message)) add(byId.get(id));
  if (picked.length > 0) return picked;

  const words = tokens(message);
  if (words.size > 0) {
    const scored = all
      .map((f) => {
        const hay = tokens(
          `${f.title} ${f.category} ${f.ruleId} ${f.explanation}`
        );
        let score = 0;
        for (const w of words) if (hay.has(w)) score++;
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { f } of scored) add(f);
  }
  if (picked.length > 0) return picked;

  if (
    /\b(fixed|resolved|gone|still|changed|since|compare|difference|previous|earlier|last)\b/i.test(
      message
    )
  ) {
    for (const f of latest.resolved) add(f);
    for (const f of latest.findings) add(f);
  }
  if (picked.length === 0) for (const f of latest.findings) add(f);
  return picked;
}

/** Everything the chat model is allowed to know, as text. Deterministic. */
export function buildDigest(view: MemoryView, message: string): string {
  if (!view.target || view.audits.length === 0 || !view.latest) {
    return [
      "MEMORY: ShipGuard has not completed any audit for the active project yet.",
      "There are no findings to discuss. Suggest pasting a public GitHub repository URL to start one."
    ].join("\n");
  }

  const latest = view.latest;
  const t = view.target;
  const out: string[] = [];
  out.push(
    `MEMORY (recorded by ShipGuard; this is the only source of truth about what was audited)`
  );
  out.push(
    `Active project: ${t.owner}/${t.repo}${t.subpath ? `/${t.subpath}` : ""}`
  );
  out.push(
    `Audits, newest first:\n${view.audits.map((a) => `- ${label(a)}`).join("\n")}`
  );

  const m = latest.manifest;
  out.push(
    `Coverage of the latest audit: ${m.filesSelected} of ${m.filesDiscovered} files selected for inspection` +
      `${m.treeTruncated ? " (GitHub truncated the file list)" : ""}. Files outside this set were NOT inspected.` +
      `${m.neverFetched.length > 0 ? ` Secret-bearing files present but not read: ${m.neverFetched.join(", ")}.` : ""}`
  );
  if (latest.aiStatus === "failed") {
    out.push(
      `AI analysis for the latest audit was unavailable${latest.aiNote ? `: ${latest.aiNote}` : ""}; only rule-based findings exist.`
    );
  }

  out.push(
    latest.findings.length > 0
      ? `Findings in the latest audit (${label(latest)}):\n${latest.findings
          .map((f) =>
            summaryLine(
              f,
              latest.changes[f.fingerprint],
              latest.dispositions[f.fingerprint]
            )
          )
          .join("\n")}`
      : `The latest audit reported no findings.`
  );

  if (latest.previousAuditId) {
    const prev = view.audits.find((a) => a.id === latest.previousAuditId);
    const resolved = latest.resolved.map((f) => `${f.displayId} ${f.title}`);
    const fresh = latest.findings
      .filter((f) => latest.changes[f.fingerprint] === "new")
      .map((f) => `${f.displayId} ${f.title}`);
    const persisting = latest.findings
      .filter((f) => latest.changes[f.fingerprint] === "persisting")
      .map((f) => f.displayId);
    out.push(
      `Change since the previous audit${prev ? ` (${label(prev)})` : ""}:\n` +
        `- Resolved: ${resolved.length ? resolved.join("; ") : "none"}\n` +
        `- New: ${fresh.length ? fresh.join("; ") : "none"}\n` +
        `- Still present: ${persisting.length ? persisting.join(", ") : "none"}`
    );
  }

  if (latest.plan.length > 0)
    out.push(
      `Remediation plan from the latest audit:\n${latest.plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    );

  for (const f of pickDetailed(message, latest, view))
    out.push(detailBlock(f, view));

  const text = out.join("\n\n");
  return text.length > MAX_DIGEST_CHARS
    ? `${text.slice(0, MAX_DIGEST_CHARS)}\n[memory truncated]`
    : text;
}
