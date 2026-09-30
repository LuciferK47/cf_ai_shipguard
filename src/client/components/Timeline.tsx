import { useEffect, useRef, useState } from "react";
import type { StageState } from "../../shared/types";
import { formatMs } from "../format";

const ICON: Record<StageState["status"], string> = {
  done: "✓",
  running: "•",
  pending: "",
  failed: "!",
  skipped: "–"
};

const STATUS_WORD: Record<StageState["status"], string> = {
  done: "done",
  running: "in progress",
  pending: "waiting",
  failed: "failed",
  skipped: "skipped"
};

/** Announce a stage when it finishes, so screen-reader users follow progress. */
function useAnnouncement(stages: StageState[] | undefined): string {
  const [text, setText] = useState("");
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    if (!stages) return;
    for (const s of stages) {
      const before = seen.current.get(s.id);
      if (
        before !== undefined &&
        before !== s.status &&
        (s.status === "done" || s.status === "failed")
      ) {
        setText(
          `${s.label}: ${STATUS_WORD[s.status]}${s.detail ? `. ${s.detail}` : ""}`
        );
      }
      seen.current.set(s.id, s.status);
    }
  }, [stages]);
  return text;
}

export function Timeline({ stages }: { stages: StageState[] }) {
  const announcement = useAnnouncement(stages);
  const done = stages.filter((s) => s.status === "done").length;
  return (
    <div>
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      <ol
        className="timeline"
        aria-label={`Audit progress, ${done} of ${stages.length} stages done`}
      >
        {stages.map((s) => (
          <li key={s.id} className="stage" data-status={s.status}>
            <span
              className={`icon ${s.status === "running" ? "pulse" : ""}`}
              aria-hidden="true"
            >
              {ICON[s.status]}
            </span>
            <span>
              <span className="label">
                {s.label}
                <span className="sr-only"> — {STATUS_WORD[s.status]}</span>
              </span>
              {s.detail && <span className="detail">{s.detail}</span>}
            </span>
            <span className="ms">{formatMs(s.ms)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
