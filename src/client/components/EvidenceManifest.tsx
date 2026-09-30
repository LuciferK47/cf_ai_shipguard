import type { Manifest } from "../../shared/types";
import { plural } from "../format";

const SHOWN: Record<string, string> = {
  full: "Whole file",
  partial: "Part of file",
  no: "Not shown"
};

/** What was looked at, what the model saw, and what was skipped or never read. */
export function EvidenceManifest({ manifest }: { manifest: Manifest }) {
  const skipped = Object.entries(manifest.skipped).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0 }}>
        ShipGuard found{" "}
        <strong>{plural(manifest.filesDiscovered, "file")}</strong> in{" "}
        <span className="mono">{manifest.repo}</span>, selected{" "}
        <strong>{manifest.filesSelected}</strong> and skipped{" "}
        <strong>{manifest.filesSkipped}</strong>.{" "}
        <strong>Anything outside the selected files was not inspected.</strong>
      </p>

      {manifest.treeTruncated && (
        <p className="callout callout-warn">
          GitHub truncated the file list for this repository, so some files were
          never seen.
        </p>
      )}

      <section aria-labelledby="sel-h">
        <h3 id="sel-h" className="section-title">
          Selected files
        </h3>
        {manifest.selected.length === 0 ? (
          <p className="hint">No files were selected.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Why</th>
                  <th scope="col">Read</th>
                  <th scope="col">Shown to model</th>
                </tr>
              </thead>
              <tbody>
                {manifest.selected.map((f) => (
                  <tr key={f.path}>
                    <td className="mono" style={{ overflowWrap: "anywhere" }}>
                      {f.path}
                    </td>
                    <td>{f.reason}</td>
                    <td>
                      {f.fetched ? (
                        `${f.chars.toLocaleString()} chars`
                      ) : (
                        <span className="badge badge-fail">
                          Not read{f.error ? `: ${f.error}` : ""}
                        </span>
                      )}
                    </td>
                    <td>{SHOWN[f.shownToAi]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {skipped.length > 0 && (
        <section aria-labelledby="skip-h">
          <h3 id="skip-h" className="section-title">
            Skipped
          </h3>
          <div className="stat-row">
            {skipped.map(([reason, n]) => (
              <span key={reason} className="badge">
                {n} × {reason}
              </span>
            ))}
          </div>
        </section>
      )}

      {manifest.neverFetched.length > 0 && (
        <section aria-labelledby="never-h">
          <h3 id="never-h" className="section-title">
            Present but deliberately not read
          </h3>
          <p className="hint" style={{ margin: "0 0 6px" }}>
            Secret-bearing files are never downloaded. They are listed so you
            know they exist in the repository.
          </p>
          <div className="stat-row">
            {manifest.neverFetched.map((p) => (
              <span key={p} className="badge mono">
                {p}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
