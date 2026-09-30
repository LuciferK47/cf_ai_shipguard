import type { Evidence, Finding, Severity, Target } from "../shared/types";

/** GitHub URL of an evidence location, pinned to the audited commit. */
export function githubBlobUrl(
  target: Pick<Target, "owner" | "repo">,
  sha: string,
  e: Evidence
): string {
  const path = e.path.split("/").map(encodeURIComponent).join("/");
  const lines = e.lineStart
    ? `#L${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-L${e.lineEnd}` : ""}`
    : "";
  return `https://github.com/${target.owner}/${target.repo}/blob/${sha}/${path}${lines}`;
}

/** "wrangler.jsonc:6" or "wrangler.jsonc:6-9" */
export function locationLabel(e: Evidence): string {
  if (!e.lineStart) return e.path;
  return `${e.path}:${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function projectName(
  t: Pick<Target, "owner" | "repo" | "subpath">
): string {
  return `${t.owner}/${t.repo}${t.subpath ? `/${t.subpath}` : ""}`;
}

/** Only ever link to https URLs. */
export function safeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000
    ? `${Math.max(1, Math.round(ms))} ms`
    : `${(ms / 1000).toFixed(1)} s`;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info"
};

export function sourceLabel(f: Finding): string {
  return f.source === "rule" ? f.ruleId : "AI · evidence verified";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
