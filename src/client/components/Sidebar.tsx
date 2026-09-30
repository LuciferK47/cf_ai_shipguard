import { useState, type FormEvent } from "react";
import type { AuditSummary, ShipGuardState } from "../../shared/types";
import { SEVERITY_ORDER } from "../../shared/types";
import { plural, projectName, relativeTime, shortSha } from "../format";
import { DEMO_URL } from "../useShipGuard";
import { SeverityBadge } from "./SeverityBadge";
import type { StartResult } from "../../server/agent";

interface Props {
  state: ShipGuardState;
  selectedId?: string;
  connected: boolean;
  running: boolean;
  onSelect: (id: string) => void;
  onStart: (url: string) => Promise<StartResult>;
}

function statusBadge(a: AuditSummary) {
  if (a.status === "failed")
    return <span className="badge badge-fail">Failed</span>;
  if (a.status === "running") return <span className="badge">Running</span>;
  return <span className="badge badge-ok">Complete</span>;
}

export function Sidebar({
  state,
  selectedId,
  connected,
  running,
  onSelect,
  onStart
}: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    setBusy(true);
    setError(undefined);
    const res = await onStart(value.trim());
    setBusy(false);
    if (!res.ok) setError(res.error.message);
    else setUrl("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(url);
  };

  const disabled = !connected || running || busy;

  return (
    <nav aria-label="Audits" className="h-full">
      <div className="section">
        <form onSubmit={onSubmit} noValidate>
          <label className="field" htmlFor="repo-url">
            Audit a repository
          </label>
          <input
            id="repo-url"
            className="input mono"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo"
            value={url}
            maxLength={300}
            aria-describedby="repo-hint repo-error"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p id="repo-hint" className="hint">
            Public repositories only. A{" "}
            <span className="mono">/tree/branch/folder</span> URL audits one
            folder of a monorepo.
          </p>
          {error && (
            <p id="repo-error" className="error-text" role="alert">
              {error}
            </p>
          )}
          <div
            style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}
          >
            <button
              type="submit"
              className="btn btn-primary"
              disabled={disabled || url.trim() === ""}
            >
              {running ? "Audit running…" : "Run audit"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              onClick={() => void submit(DEMO_URL)}
              title="Audits the example Worker that ships with this project, which has a seeded Durable Object mistake"
            >
              Try the demo
            </button>
          </div>
        </form>
      </div>

      <div className="section">
        <h2 className="section-title">Audit history</h2>
        {state.recent.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No audits yet. Your history is saved in this workspace and survives
            reloads.
          </p>
        ) : (
          <ul className="audit-list">
            {state.recent.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="audit-item"
                  aria-current={a.id === selectedId}
                  onClick={() => onSelect(a.id)}
                >
                  <span className="name">{projectName(a.target)}</span>
                  <span className="meta" style={{ display: "block" }}>
                    {a.target.ref ?? "default"}{" "}
                    {a.sha ? `@ ${shortSha(a.sha)}` : ""} ·{" "}
                    {relativeTime(a.createdAt)}
                  </span>
                  <span className="chips">
                    {statusBadge(a)}
                    {a.status === "complete" &&
                      a.headline === "No findings" && (
                        <span className="badge">No findings</span>
                      )}
                    {a.status === "complete" &&
                      SEVERITY_ORDER.filter((s) => a.counts[s] > 0).map((s) => (
                        <span
                          key={s}
                          className="finding-row"
                          style={{ gap: 3 }}
                        >
                          <SeverityBadge severity={s} />
                          <strong>{a.counts[s]}</strong>
                        </span>
                      ))}
                  </span>
                  {a.status === "failed" && a.error && (
                    <span
                      className="meta"
                      style={{ display: "block", marginTop: 4 }}
                    >
                      {a.error.message}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.recent.length > 0 && (
          <p className="hint">
            {plural(state.recent.length, "audit")} shown. The most recent{" "}
            {plural(20, "audit")} of each project are kept.
          </p>
        )}
      </div>
    </nav>
  );
}
