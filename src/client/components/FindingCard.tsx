import type {
  AuditDetail,
  Finding,
  FindingChange,
  FindingStatus
} from "../../shared/types";
import {
  githubBlobUrl,
  locationLabel,
  safeHttpsUrl,
  sourceLabel
} from "../format";
import { SeverityBadge } from "./SeverityBadge";

const CHANGE_LABEL: Record<FindingChange, string> = {
  new: "New",
  persisting: "Still present",
  resolved: "Resolved"
};

interface Props {
  finding: Finding;
  detail: AuditDetail;
  change?: FindingChange;
  status: FindingStatus;
  defaultOpen?: boolean;
  onStatus: (ref: string, status: FindingStatus) => void;
}

export function FindingCard({
  finding: f,
  detail,
  change,
  status,
  defaultOpen,
  onStatus
}: Props) {
  const docs = safeHttpsUrl(f.docsUrl);
  const id = f.displayId ?? f.fingerprint;
  return (
    <article className="finding" data-status={status} data-change={change}>
      <details open={defaultOpen}>
        <summary className="finding-head">
          <span className="finding-row">
            <span className="finding-id">{f.displayId}</span>
            <SeverityBadge severity={f.severity} />
            {change && (
              <span
                className={`badge ${change === "resolved" ? "badge-ok" : ""}`}
              >
                {CHANGE_LABEL[change]}
              </span>
            )}
            {status !== "open" && (
              <span className="badge">
                {status === "accepted" ? "Accepted" : "Dismissed"}
              </span>
            )}
          </span>
          <h3>{f.title}</h3>
          <span className="finding-row">
            <span className="badge badge-muted mono">{sourceLabel(f)}</span>
            {f.evidence[0] && (
              <span className="badge badge-muted mono">
                {locationLabel(f.evidence[0])}
              </span>
            )}
            <span className="badge badge-muted">
              confidence {Math.round(f.confidence * 100)}%
            </span>
          </span>
        </summary>

        <div className="finding-body">
          <div>
            <h4>Why it matters</h4>
            <p>{f.explanation}</p>
          </div>
          <div>
            <h4>Suggested fix</h4>
            <p>{f.recommendation}</p>
          </div>

          {f.evidence.length > 0 && (
            <div>
              <h4>Evidence</h4>
              <div style={{ display: "grid", gap: 8 }}>
                {f.evidence.map((e, i) => (
                  <div
                    key={`${e.path}:${e.lineStart}:${i}`}
                    className="evidence"
                  >
                    <header>
                      <a
                        className="link mono"
                        href={githubBlobUrl(detail.target, detail.sha, e)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {locationLabel(e)}
                      </a>
                    </header>
                    {e.excerpt ? (
                      <pre>{e.excerpt}</pre>
                    ) : (
                      <pre className="sr-only">No excerpt</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="finding-row">
            {docs && (
              <a
                className="link"
                href={docs}
                target="_blank"
                rel="noopener noreferrer"
              >
                Cloudflare documentation
              </a>
            )}
            {f.source === "ai" && (
              <span className="hint" style={{ margin: 0 }}>
                Suggested by the model; every cited path and line was checked
                against the files it was shown.
              </span>
            )}
          </div>

          {change !== "resolved" && (
            <div
              className="finding-row"
              role="group"
              aria-label={`Decision for ${id}`}
            >
              <button
                type="button"
                className="btn btn-small"
                aria-pressed={status === "accepted"}
                onClick={() =>
                  onStatus(id, status === "accepted" ? "open" : "accepted")
                }
              >
                {status === "accepted" ? "Accepted" : "Accept risk"}
              </button>
              <button
                type="button"
                className="btn btn-small"
                aria-pressed={status === "dismissed"}
                onClick={() =>
                  onStatus(id, status === "dismissed" ? "open" : "dismissed")
                }
              >
                {status === "dismissed" ? "Dismissed" : "Dismiss"}
              </button>
              {status !== "open" && (
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  onClick={() => onStatus(id, "open")}
                >
                  Reopen
                </button>
              )}
            </div>
          )}
        </div>
      </details>
    </article>
  );
}
