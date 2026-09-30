import type { AuditError, ErrorCode } from "../../shared/types";
import { GithubError } from "../github/client";

// Workflow errors cross a serialisation boundary, and only the message is
// guaranteed to survive. The audit error code therefore travels as a
// "[CODE] " prefix and is decoded again where the failure is recorded.

const KNOWN: ReadonlySet<string> = new Set<ErrorCode>([
  "INVALID_URL",
  "NOT_FOUND",
  "RATE_LIMITED",
  "GITHUB_UNAVAILABLE",
  "NO_FILES",
  "REPO_TOO_LARGE",
  "AI_UNAVAILABLE",
  "AI_INVALID_OUTPUT",
  "LIMIT_REACHED",
  "WORKFLOW_FAILED",
  "STALE"
]);

export function encodeFailure(code: ErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

const GENERIC = "The audit failed unexpectedly. Please try again.";

/** Turn any thrown value into a user-facing error. Never exposes a stack trace. */
export function decodeFailure(err: unknown): AuditError {
  if (err instanceof GithubError)
    return { code: err.code, message: err.message };
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /^\[([A-Z_]+)\]\s+([\s\S]{1,400})$/.exec(raw.trim());
  if (m && KNOWN.has(m[1]))
    return { code: m[1] as ErrorCode, message: m[2].trim() };
  return { code: "WORKFLOW_FAILED", message: GENERIC };
}
