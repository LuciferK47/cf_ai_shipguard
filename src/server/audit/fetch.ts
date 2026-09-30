import { GithubError, looksBinary, type GithubClient } from "../github/client";
import type { FileToFetch } from "../ingest/select";
import { MAX_FILE_BYTES } from "../limits";

export interface FetchedFile {
  path: string;
  reason: string;
  /** Present only when the file was fetched and kept. */
  text?: string;
  chars: number;
  /** Why the file is not available, in plain words. */
  error?: string;
}

export interface FetchOutcome {
  files: FetchedFile[];
  /** Set when GitHub rate-limited us; the caller should stop the audit. */
  rateLimited?: GithubError;
}

/** How many transient failures are retried, per fetch step. Keeps the subrequest budget bounded. */
export const MAX_TRANSIENT_RETRIES = 6;

interface Attempt extends FetchedFile {
  rate?: GithubError;
  /** True when trying again might succeed (timeout, network error, 5xx). */
  transient?: boolean;
}

async function attempt(
  client: GithubClient,
  owner: string,
  repo: string,
  sha: string,
  p: FileToFetch
): Promise<Attempt> {
  try {
    const raw = await client.getRaw(owner, repo, sha, p.path, MAX_FILE_BYTES);
    if (raw.truncated) {
      return {
        path: p.path,
        reason: p.reason,
        chars: 0,
        error: "file is larger than the size limit"
      };
    }
    if (looksBinary(raw.text)) {
      return { path: p.path, reason: p.reason, chars: 0, error: "binary file" };
    }
    return {
      path: p.path,
      reason: p.reason,
      text: raw.text,
      chars: raw.text.length
    };
  } catch (err) {
    if (err instanceof GithubError) {
      const limited = err.code === "RATE_LIMITED";
      return {
        path: p.path,
        reason: p.reason,
        chars: 0,
        error: limited ? "GitHub rate limit reached" : err.message,
        rate: limited ? err : undefined,
        transient: err.retryable
      };
    }
    return {
      path: p.path,
      reason: p.reason,
      chars: 0,
      error: "unexpected error"
    };
  }
}

/**
 * Fetch files pinned to a commit.
 *
 * A file that cannot be fetched is recorded with its reason instead of failing
 * the step: a step that throws is retried as a whole, which would repeat every
 * request and burn the subrequest budget. Instead, transient failures (a
 * timeout, a network error, a 5xx) are retried once here, for at most
 * MAX_TRANSIENT_RETRIES files. Only a rate limit is reported to the caller,
 * because carrying on would fail every remaining request too.
 */
export async function fetchFiles(
  client: GithubClient,
  owner: string,
  repo: string,
  sha: string,
  picks: readonly FileToFetch[],
  remainingChars: number
): Promise<FetchOutcome> {
  let results = await Promise.all(
    picks.map((p) => attempt(client, owner, repo, sha, p))
  );

  const retryIdx = results
    .map((r, i) => (r.transient && !r.rate ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, MAX_TRANSIENT_RETRIES);
  if (retryIdx.length > 0) {
    const second = await Promise.all(
      retryIdx.map((i) => attempt(client, owner, repo, sha, picks[i]))
    );
    results = results.map((r, i) => {
      const k = retryIdx.indexOf(i);
      return k >= 0 ? second[k] : r;
    });
  }

  // Apply the total-size budget in priority order (picks are already ranked).
  let budget = remainingChars;
  const files: FetchedFile[] = [];
  let rateLimited: GithubError | undefined;
  for (const s of results) {
    const { rate, transient: _transient, ...file } = s;
    if (rate) rateLimited ??= rate;
    if (file.text !== undefined) {
      if (file.chars > budget) {
        files.push({
          path: file.path,
          reason: file.reason,
          chars: 0,
          error: "over the total size budget"
        });
        continue;
      }
      budget -= file.chars;
    }
    files.push(file);
  }
  return { files, rateLimited };
}
