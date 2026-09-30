import { GITHUB_TIMEOUT_MS, MAX_FILE_BYTES } from "../limits";
import type { ErrorCode } from "../../shared/types";

// Read-only GitHub access.
//  - Repository, commit and tree metadata come from api.github.com.
//  - File bodies come from raw.githubusercontent.com, pinned to a commit SHA,
//    which does not consume REST API quota.
// The token (optional) is only ever sent to api.github.com.

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const SHA_RE = /^[0-9a-f]{40}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
// Branch names may contain "/" (for example release/1.0), so refs are checked
// per segment rather than as one segment.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class GithubError extends Error {
  readonly code: ErrorCode;
  /** True when trying again later may succeed (timeouts, 5xx). */
  readonly retryable: boolean;
  /** Epoch seconds when a rate limit resets, if GitHub said so. */
  readonly resetAt?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; resetAt?: number } = {}
  ) {
    super(message);
    this.name = "GithubError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.resetAt = opts.resetAt;
  }
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  archived: boolean;
  sizeKb: number;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

export interface TreeResult {
  entries: TreeEntry[];
  /** GitHub stops at 100,000 entries or 7 MB; the list is then incomplete. */
  truncated: boolean;
}

export interface RawFile {
  text: string;
  bytes: number;
  /** True when the body was cut at the byte limit. */
  truncated: boolean;
}

export interface GithubClientOptions {
  fetch?: typeof fetch;
  token?: string;
  timeoutMs?: number;
}

export interface GithubClient {
  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  getCommitSha(owner: string, repo: string, ref: string): Promise<string>;
  getTree(owner: string, repo: string, sha: string): Promise<TreeResult>;
  getRaw(
    owner: string,
    repo: string,
    sha: string,
    path: string,
    maxBytes?: number
  ): Promise<RawFile>;
}

function assertSegment(value: string, what: string): void {
  if (!SEGMENT_RE.test(value) || value === "." || value === "..") {
    throw new GithubError("INVALID_URL", `Invalid ${what}.`);
  }
}

export function createGithubClient(
  opts: GithubClientOptions = {}
): GithubClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;

  async function request(url: string, headers: HeadersInit): Promise<Response> {
    try {
      return await doFetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new GithubError(
        "GITHUB_UNAVAILABLE",
        timedOut ? "GitHub did not answer in time." : "Could not reach GitHub.",
        { retryable: true }
      );
    }
  }

  function apiHeaders(accept = "application/vnd.github+json"): HeadersInit {
    const h: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cf-ai-shipguard"
    };
    if (opts.token) h.Authorization = `Bearer ${opts.token}`;
    return h;
  }

  function mapError(res: Response, what: string): GithubError {
    const status = res.status;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = res.headers.get("retry-after");
    if (
      (status === 403 || status === 429) &&
      (remaining === "0" || retryAfter !== null || status === 429)
    ) {
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset : undefined;
      const when = resetAt
        ? ` Resets at ${new Date(resetAt * 1000).toISOString()}.`
        : "";
      return new GithubError(
        "RATE_LIMITED",
        `GitHub rate limit reached.${when}${
          opts.token ? "" : " Deployments should configure GITHUB_TOKEN."
        }`,
        { resetAt }
      );
    }
    if (status === 404 || status === 451 || status === 403) {
      return new GithubError(
        "NOT_FOUND",
        `${what} was not found. It may not exist, or the repository may be private (only public repositories are supported).`
      );
    }
    if (status === 409) {
      return new GithubError("NOT_FOUND", "The repository is empty.");
    }
    if (status === 422) {
      return new GithubError(
        "NOT_FOUND",
        "That branch, tag or commit does not exist in the repository."
      );
    }
    if (status === 401) {
      return new GithubError(
        "GITHUB_UNAVAILABLE",
        "GitHub rejected the configured token. Check the GITHUB_TOKEN secret."
      );
    }
    return new GithubError(
      "GITHUB_UNAVAILABLE",
      `GitHub returned HTTP ${status}.`,
      { retryable: status >= 500 }
    );
  }

  return {
    async getRepo(owner, repo) {
      assertSegment(owner, "owner");
      assertSegment(repo, "repository");
      const res = await request(`${API}/repos/${owner}/${repo}`, apiHeaders());
      if (!res.ok) throw mapError(res, "The repository");
      const body = (await res.json()) as {
        full_name?: string;
        default_branch?: string;
        private?: boolean;
        archived?: boolean;
        size?: number;
      };
      if (!body.default_branch || typeof body.full_name !== "string") {
        throw new GithubError(
          "GITHUB_UNAVAILABLE",
          "GitHub returned an unexpected repository response."
        );
      }
      if (body.private) {
        throw new GithubError(
          "NOT_FOUND",
          "That repository is private. Only public repositories are supported."
        );
      }
      return {
        fullName: body.full_name,
        defaultBranch: body.default_branch,
        isPrivate: false,
        archived: body.archived === true,
        sizeKb: typeof body.size === "number" ? body.size : 0
      };
    },

    async getCommitSha(owner, repo, ref) {
      assertSegment(owner, "owner");
      assertSegment(repo, "repository");
      if (!REF_RE.test(ref) || ref.includes("..") || ref.includes("//")) {
        throw new GithubError("INVALID_URL", "Invalid ref.");
      }
      const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
      const res = await request(
        `${API}/repos/${owner}/${repo}/commits/${encodedRef}`,
        apiHeaders("application/vnd.github.sha")
      );
      if (!res.ok) throw mapError(res, "The ref");
      const sha = (await res.text()).trim();
      if (!SHA_RE.test(sha)) {
        throw new GithubError(
          "GITHUB_UNAVAILABLE",
          "GitHub returned an unexpected commit response."
        );
      }
      return sha;
    },

    async getTree(owner, repo, sha) {
      assertSegment(owner, "owner");
      assertSegment(repo, "repository");
      if (!SHA_RE.test(sha)) throw new GithubError("INVALID_URL", "Bad SHA.");
      const res = await request(
        `${API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
        apiHeaders()
      );
      if (!res.ok) throw mapError(res, "The file tree");
      const body = (await res.json()) as {
        tree?: Array<{ path?: string; type?: string; size?: number }>;
        truncated?: boolean;
      };
      if (!Array.isArray(body.tree)) {
        throw new GithubError(
          "GITHUB_UNAVAILABLE",
          "GitHub returned an unexpected tree response."
        );
      }
      const entries: TreeEntry[] = [];
      for (const e of body.tree) {
        if (
          typeof e.path === "string" &&
          (e.type === "blob" || e.type === "tree" || e.type === "commit")
        ) {
          entries.push({ path: e.path, type: e.type, size: e.size });
        }
      }
      return { entries, truncated: body.truncated === true };
    },

    async getRaw(owner, repo, sha, path, maxBytes = MAX_FILE_BYTES) {
      assertSegment(owner, "owner");
      assertSegment(repo, "repository");
      if (!SHA_RE.test(sha)) throw new GithubError("INVALID_URL", "Bad SHA.");
      const encoded = path
        .split("/")
        .map((s) => {
          if (s === "" || s === "." || s === "..") {
            throw new GithubError("INVALID_URL", "Bad file path.");
          }
          return encodeURIComponent(s);
        })
        .join("/");
      // No Authorization header: raw content of public repositories needs none.
      const res = await request(`${RAW}/${owner}/${repo}/${sha}/${encoded}`, {
        "User-Agent": "cf-ai-shipguard"
      });
      if (!res.ok) throw mapError(res, "The file");
      return readCapped(res, maxBytes);
    }
  };
}

/** Read a response body without ever holding more than `maxBytes` in memory. */
export async function readCapped(
  res: Response,
  maxBytes: number
): Promise<RawFile> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const keep = maxBytes - total;
      if (keep > 0) chunks.push(value.subarray(0, keep));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  return { text, bytes: total, truncated };
}

/** Heuristic binary check: NUL bytes in the first few KB. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}
