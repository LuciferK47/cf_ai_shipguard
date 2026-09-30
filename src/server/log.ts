import { safeForLog } from "./security/redact";

/**
 * One JSON object per line, so Workers Logs can filter on any field.
 * String values are redacted and truncated; tokens and secrets never appear.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = typeof v === "string" ? safeForLog(v) : v;
  }
  console.log(JSON.stringify({ event, ...safe }));
}
