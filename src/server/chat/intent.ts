import { findGithubUrls } from "../github/target";
import { parseDisplayId } from "../findings/ids";
import type { FindingStatus } from "../../shared/types";

// Chat messages are routed by plain code, not by the model. Starting an audit
// or changing a disposition is a decision the user makes explicitly; the model
// only ever answers questions.

export type Intent =
  | { kind: "audit"; url: string }
  | { kind: "reaudit" }
  | { kind: "disposition"; ref: string; status: FindingStatus; note?: string }
  | { kind: "question" };

const DISPOSITION =
  /^\s*(accept|dismiss|ignore|reopen|re-open)\s+(?:finding\s+)?(F-\d{1,5})\b\s*(?:(?:because|as|:|-|—)\s*)?(.*)$/i;

const REAUDIT =
  /\b(?:re-?audit|audit\s+(?:it|this|that|again)|(?:run|do)\s+(?:the\s+)?(?:audit|it|that|this)\s+again|re-?run|check\s+again|scan\s+again)\b/i;

const STATUS: Record<string, FindingStatus> = {
  accept: "accepted",
  dismiss: "dismissed",
  ignore: "dismissed",
  reopen: "open",
  "re-open": "open"
};

export function detectIntent(
  message: string,
  hasActiveTarget: boolean
): Intent {
  const dispo = DISPOSITION.exec(message);
  if (dispo) {
    const ref = parseDisplayId(dispo[2]);
    if (ref) {
      const note = dispo[3].trim().slice(0, 300);
      return {
        kind: "disposition",
        ref,
        status: STATUS[dispo[1].toLowerCase()],
        note: note || undefined
      };
    }
  }

  const url = findGithubUrls(message)[0];
  if (url) return { kind: "audit", url };

  if (hasActiveTarget && REAUDIT.test(message)) return { kind: "reaudit" };
  return { kind: "question" };
}
