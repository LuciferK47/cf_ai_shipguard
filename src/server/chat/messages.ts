import type {
  AuditDetail,
  AuditError,
  AuditSummary,
  Finding,
  Target
} from "../../shared/types";

// Messages ShipGuard writes into the chat itself. They are built by code from
// stored data, so they cost no model call and cannot be influenced by
// repository text (excerpts are never included here).

function name(t: Target): string {
  return `${t.owner}/${t.repo}${t.subpath ? `/${t.subpath}` : ""}`;
}

function loc(f: Finding): string {
  const e = f.evidence[0];
  if (!e) return "";
  return ` (\`${e.path}${e.lineStart ? `:${e.lineStart}` : ""}\`)`;
}

export function startedMessage(target: Target, auditId: string): string {
  return `Started audit \`${auditId.slice(0, 8)}\` of **${name(target)}**${target.ref ? ` at \`${target.ref}\`` : ""}. Progress is shown in the investigation panel and continues even if you close this tab.`;
}

export function failedMessage(
  target: Target | undefined,
  error: AuditError
): string {
  const where = target ? ` of **${name(target)}**` : "";
  return `The audit${where} could not be completed.\n\n**${error.code.replace(/_/g, " ").toLowerCase()}**: ${error.message}`;
}

export function invalidUrlMessage(reason: string): string {
  return `I can only audit public GitHub repositories. ${reason}\n\nExample: \`https://github.com/owner/repo\` or \`https://github.com/owner/repo/tree/main/path\`.`;
}

export function completedMessage(
  detail: AuditDetail,
  aiSummary?: string
): string {
  const t = detail.target;
  const lines: string[] = [];
  lines.push(
    `**Audit complete** for **${name(t)}** at \`${t.ref ?? "default branch"}\` (\`${detail.sha.slice(0, 7)}\`): ${detail.headline}.`
  );

  const m = detail.manifest;
  lines.push(
    `Inspected ${m.filesSelected} of ${m.filesDiscovered} files. Files outside this set were not inspected.`
  );

  if (detail.previousAuditId) {
    const fixed = detail.resolved.map((f) => `${f.displayId} ${f.title}`);
    const persisting = detail.findings.filter(
      (f) => detail.changes[f.fingerprint] === "persisting"
    );
    const fresh = detail.findings.filter(
      (f) => detail.changes[f.fingerprint] === "new"
    );
    lines.push(
      `Since the previous audit: ${fixed.length} resolved, ${persisting.length} still present, ${fresh.length} new.` +
        (fixed.length ? `\nResolved: ${fixed.join("; ")}` : "")
    );
  }

  if (detail.findings.length > 0) {
    lines.push(
      detail.findings
        .slice(0, 6)
        .map(
          (f) =>
            `- **${f.displayId}** [${f.severity}] ${f.title}${loc(f)}${detail.changes[f.fingerprint] === "persisting" ? " — still present" : ""}`
        )
        .join("\n") +
        (detail.findings.length > 6
          ? `\n- …and ${detail.findings.length - 6} more in the panel`
          : "")
    );
  }

  if (aiSummary) lines.push(`**AI summary:** ${aiSummary}`);
  if (detail.aiStatus === "failed") {
    lines.push(
      `_AI analysis was unavailable${detail.aiNote ? ` (${detail.aiNote})` : ""}. The findings above come from deterministic rules only._`
    );
  }
  lines.push(
    "Ask me about any finding, for example _“What should I fix first?”_"
  );
  return lines.join("\n\n");
}

export function dispositionMessage(
  ref: string,
  status: string,
  ok: boolean
): string {
  if (!ok) return `I have no finding **${ref}** for the active project.`;
  if (status === "open") return `Reopened **${ref}**.`;
  return `Marked **${ref}** as ${status}. I will remember this for later audits.`;
}

export function noActiveTargetMessage(): string {
  return "There is no project to re-audit yet. Paste a public GitHub repository URL to start.";
}

export function rateLimitMessage(perHour: number): string {
  return `This workspace has started ${perHour} audits in the last hour, which is the limit. Try again a little later.`;
}

export function busyMessage(summary: AuditSummary): string {
  return `An audit of **${name(summary.target)}** is still running. I will post the result here when it finishes.`;
}
