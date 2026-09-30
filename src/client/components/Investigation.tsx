import { useRef, useState, type KeyboardEvent } from "react";
import {
  SEVERITY_ORDER,
  type AuditDetail,
  type StageState
} from "../../shared/types";
import {
  formatMs,
  plural,
  projectName,
  shortSha,
  SEVERITY_LABEL
} from "../format";
import { EvidenceManifest } from "./EvidenceManifest";
import { FindingCard } from "./FindingCard";
import { SeverityBadge } from "./SeverityBadge";
import { Timeline } from "./Timeline";
import type { FindingStatus } from "../../shared/types";

type Tab = "summary" | "findings" | "evidence" | "plan";

interface Props {
  detail?: AuditDetail;
  stages?: StageState[];
  running: boolean;
  error?: string;
  connected: boolean;
  onStatus: (ref: string, status: FindingStatus) => void;
  onReaudit: () => void;
  canReaudit: boolean;
}

export function Investigation({
  detail,
  stages,
  running,
  error,
  connected,
  onStatus,
  onReaudit,
  canReaudit
}: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    summary: null,
    findings: null,
    evidence: null,
    plan: null
  });

  if (!detail && !stages) {
    return (
      <div className="empty">
        <h3>No investigation yet</h3>
        <p>
          ShipGuard checks a public Cloudflare Workers repository before you
          deploy it.
        </p>
        <ol>
          <li>Paste a GitHub URL on the left, or try the demo repository.</li>
          <li>Watch each stage finish here as it really happens.</li>
          <li>Open a finding to see the exact file, line and fix.</li>
          <li>Ask about it in chat. ShipGuard remembers every audit.</li>
        </ol>
        {!connected && (
          <p className="callout callout-warn">Connecting to your workspace…</p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "summary", label: "Summary" },
    {
      id: "findings",
      label: detail ? `Findings (${detail.findings.length})` : "Findings"
    },
    { id: "evidence", label: "Evidence" },
    { id: "plan", label: "Actions" }
  ];

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setTab(tabs[next].id);
    tabRefs.current[tabs[next].id]?.focus();
  };

  const title = detail ? projectName(detail.target) : "Audit in progress";
  const done = stages?.filter((s) => s.status === "done").length ?? 0;
  const total = stages?.reduce((n, s) => n + (s.ms ?? 0), 0) ?? 0;

  return (
    <div>
      <div className="panel-head">
        <h2>{title}</h2>
        {detail && (
          <p className="sub mono">
            {detail.target.ref ?? "default branch"} @ {shortSha(detail.sha)} ·{" "}
            {detail.status}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>

      {stages && (
        <div className="section" style={{ paddingTop: 0 }}>
          <details
            className="disclosure"
            open={running || detail?.status === "failed" || undefined}
          >
            <summary>
              Investigation timeline{" "}
              <span className="badge badge-muted">
                {done}/{stages.length} stages
                {!running && total > 0 ? ` · ${formatMs(total)}` : ""}
              </span>
            </summary>
            <div style={{ marginTop: 8 }}>
              <Timeline stages={stages} />
            </div>
          </details>
        </div>
      )}

      {detail && (
        <>
          <div
            role="tablist"
            aria-label="Investigation report"
            className="tabs"
            tabIndex={-1}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                className="tab"
                type="button"
                onClick={() => setTab(t.id)}
                onKeyDown={onKey}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="tabpanel"
          >
            {tab === "summary" && (
              <SummaryTab
                detail={detail}
                onReaudit={onReaudit}
                canReaudit={canReaudit}
              />
            )}
            {tab === "findings" && (
              <FindingsTab detail={detail} onStatus={onStatus} />
            )}
            {tab === "evidence" && (
              <EvidenceManifest manifest={detail.manifest} />
            )}
            {tab === "plan" && <PlanTab detail={detail} />}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTab({
  detail,
  onReaudit,
  canReaudit
}: {
  detail: AuditDetail;
  onReaudit: () => void;
  canReaudit: boolean;
}) {
  const changes = Object.values(detail.changes);
  const fresh = changes.filter((c) => c === "new").length;
  const still = changes.filter((c) => c === "persisting").length;
  const fixed = detail.resolved.length;

  if (detail.status === "running")
    return (
      <p>The audit is running. Its stages are shown above as they finish.</p>
    );
  if (detail.status === "failed") {
    return (
      <div>
        <p className="callout callout-fail" role="alert">
          <strong>The audit could not be completed.</strong>
          <br />
          {detail.error?.message}
        </p>
        <p className="hint">
          Nothing was stored for this audit apart from the stages that finished.
          You can try again.
        </p>
        <button
          type="button"
          className="btn"
          onClick={onReaudit}
          disabled={!canReaudit}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div>
        <p style={{ margin: "0 0 8px", fontWeight: 650, fontSize: 15 }}>
          {detail.headline}
        </p>
        <div className="stat-row" aria-label="Findings by severity">
          {SEVERITY_ORDER.filter((s) => detail.counts[s] > 0).map((s) => (
            <span key={s} className="finding-row">
              <SeverityBadge severity={s} />
              <span className="sr-only">{SEVERITY_LABEL[s]}:</span>
              <strong>{detail.counts[s]}</strong>
            </span>
          ))}
          {detail.findings.length === 0 && (
            <span className="badge badge-ok">
              No findings in the inspected files
            </span>
          )}
        </div>
      </div>

      {detail.summary && <p style={{ margin: 0 }}>{detail.summary}</p>}

      {detail.aiStatus === "failed" && (
        <p className="callout callout-warn">
          <strong>AI analysis was unavailable.</strong> {detail.aiNote} The
          findings come from deterministic rules only.
        </p>
      )}
      {detail.aiStatus === "cached" && (
        <p className="hint">
          The AI analysis was reused from an identical earlier audit; no model
          call was made.
        </p>
      )}
      {detail.aiStatus === "ok" && detail.rejectedAiFindings > 0 && (
        <p className="hint">
          The model proposed {plural(detail.rejectedAiFindings, "finding")} that
          could not be verified against the files it was shown;{" "}
          {detail.rejectedAiFindings === 1 ? "it was" : "they were"} discarded.
        </p>
      )}

      {detail.previousAuditId && (
        <div>
          <h3 className="section-title">Since the previous audit</h3>
          <div className="stat-row">
            <span className="badge badge-ok">{fixed} resolved</span>
            <span className="badge">{still} still present</span>
            <span className="badge">{fresh} new</span>
          </div>
          {detail.resolved.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {detail.resolved.map((f) => (
                <li key={f.fingerprint}>
                  <span className="finding-id">{f.displayId}</span> {f.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <h3 className="section-title">Coverage</h3>
        <p style={{ margin: 0 }}>
          Inspected {detail.manifest.filesSelected} of{" "}
          {plural(detail.manifest.filesDiscovered, "file")}. Files outside this
          set were not inspected, so “no findings” means none in the files that
          were read.
        </p>
      </div>

      <div>
        <button
          type="button"
          className="btn"
          onClick={onReaudit}
          disabled={!canReaudit}
        >
          Re-audit this project
        </button>
      </div>
    </div>
  );
}

function FindingsTab({
  detail,
  onStatus
}: {
  detail: AuditDetail;
  onStatus: (ref: string, status: FindingStatus) => void;
}) {
  if (detail.findings.length === 0 && detail.resolved.length === 0) {
    return (
      <div className="empty" style={{ padding: 0 }}>
        <h3>No findings</h3>
        <p>
          No rule matched in the files that were read. That does not prove the
          rest of the project is free of problems; see the Evidence tab for what
          was covered.
        </p>
      </div>
    );
  }
  return (
    <div>
      {detail.findings.map((f, i) => (
        <FindingCard
          key={f.fingerprint}
          finding={f}
          detail={detail}
          change={detail.changes[f.fingerprint]}
          status={detail.dispositions[f.fingerprint]?.status ?? "open"}
          defaultOpen={i === 0}
          onStatus={onStatus}
        />
      ))}
      {detail.resolved.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 18 }}>
            Resolved since the previous audit
          </h3>
          {detail.resolved.map((f) => (
            <FindingCard
              key={f.fingerprint}
              finding={f}
              detail={detail}
              change="resolved"
              status="open"
              onStatus={onStatus}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PlanTab({ detail }: { detail: AuditDetail }) {
  if (detail.plan.length === 0) {
    return (
      <p>No remediation steps: nothing needs fixing in the inspected files.</p>
    );
  }
  return (
    <div>
      <h3 className="section-title">Recommended actions, in order</h3>
      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
        {detail.plan.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ol>
      <p className="hint">
        {detail.aiStatus === "ok" || detail.aiStatus === "cached"
          ? "Ordered by the model and checked against the findings."
          : "Built from the deterministic findings."}
      </p>
    </div>
  );
}
