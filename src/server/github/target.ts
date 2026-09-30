import { MAX_URL_CHARS } from "../limits";
import type { Target } from "../../shared/types";

// The only input that ever reaches the GitHub fetcher.
// Outbound URLs are rebuilt from the validated parts below; the user's string
// is never used as a URL. This is the SSRF boundary (see docs/SECURITY.md).

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]{1,100}$/;
const MAX_SUBPATH_DEPTH = 8;
const MAX_SUBPATH_CHARS = 200;

export type ParseResult =
  | { ok: true; target: Target }
  | { ok: false; message: string };

function fail(message: string): ParseResult {
  return { ok: false, message };
}

function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

export function parseGithubUrl(input: string): ParseResult {
  const raw = input.trim();
  if (raw.length === 0) return fail("Enter a GitHub repository URL.");
  if (raw.length > MAX_URL_CHARS) return fail("That URL is too long.");
  if (hasWhitespaceOrControl(raw)) {
    return fail("The URL must not contain whitespace or control characters.");
  }
  // Checked on the raw string: `new URL()` silently rewrites backslashes to
  // slashes and resolves `..` segments, which would hide both from the checks
  // on the parsed URL below.
  if (/[\\%]/.test(raw)) {
    return fail("The URL contains unsupported characters.");
  }
  if (/\/\.\.?(?:\/|$)/.test(raw)) {
    return fail("The URL must not contain relative path segments.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(
      "That is not a valid URL. Use https://github.com/{owner}/{repo}."
    );
  }

  if (url.protocol !== "https:")
    return fail("Only https:// URLs are accepted.");
  if (url.hostname !== "github.com") {
    return fail("Only github.com repositories are supported.");
  }
  if (url.username || url.password) {
    return fail("The URL must not contain credentials.");
  }
  if (url.port) return fail("The URL must not specify a port.");
  if (url.search) return fail("The URL must not contain a query string.");

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    return fail("Use https://github.com/{owner}/{repo}.");
  }

  const owner = segments[0];
  let repo = segments[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);

  if (!OWNER.test(owner)) return fail("The repository owner name is invalid.");
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    return fail("The repository name is invalid.");
  }

  const target: Target = { owner, repo, subpath: "" };
  const rest = segments.slice(2);
  if (rest.length === 0) return { ok: true, target };

  if (rest[0] !== "tree") {
    return fail(
      "Only repository roots and /tree/{ref}/{path} URLs are supported."
    );
  }
  if (rest.length < 2) return fail("Missing a ref after /tree/.");

  const ref = rest[1];
  if (!REF.test(ref) || ref.includes("..") || ref.endsWith(".")) {
    return fail("The branch, tag or commit name is invalid.");
  }
  target.ref = ref;

  const subSegments = rest.slice(2);
  if (subSegments.length > MAX_SUBPATH_DEPTH) {
    return fail("The sub-directory path is too deep.");
  }
  for (const seg of subSegments) {
    if (!PATH_SEGMENT.test(seg) || seg === "." || seg === "..") {
      return fail("The sub-directory path is invalid.");
    }
  }
  const subpath = subSegments.join("/");
  if (subpath.length > MAX_SUBPATH_CHARS) {
    return fail("The sub-directory path is too long.");
  }
  target.subpath = subpath;
  return { ok: true, target };
}

/** Canonical display URL for a validated target. */
export function targetUrl(target: Target): string {
  const base = `https://github.com/${target.owner}/${target.repo}`;
  if (!target.ref && !target.subpath) return base;
  const ref = target.ref ?? "HEAD";
  return `${base}/tree/${ref}${target.subpath ? `/${target.subpath}` : ""}`;
}

/**
 * Stable key for grouping audits of the same project (case-insensitive).
 * The ref is deliberately excluded: auditing a tag and then a branch of the
 * same project must be comparable, which is what lets memory report findings
 * as persisting or resolved between two commits.
 */
export function targetKey(target: Target): string {
  const sub = target.subpath ? `/${target.subpath}` : "";
  return `${target.owner}/${target.repo}${sub}`.toLowerCase();
}

/** Find candidate GitHub URLs inside free text (chat messages). */
export function findGithubUrls(text: string): string[] {
  const matches = text.match(/https:\/\/github\.com\/[^\s<>()"'`]+/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?)\]]+$/, "");
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}
