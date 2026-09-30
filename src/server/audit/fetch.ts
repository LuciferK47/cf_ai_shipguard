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

/**
 * Fetch files pinned to a commit. A file that cannot be fetched is recorded
 * with its reason instead of failing the step: a step that throws is retried,
 * and a retry would repeat every request and burn the subrequest budget.
 * Only a rate limit is reported to the caller, because carrying on would fail
 * every remaining request too.
 */
export async function fetchFiles(
  client: GithubClient,
  owner: string,
  repo: string,
  sha: string,
  picks: readonly FileToFetch[],
  remainingChars: number
): Promise<FetchOutcome> {
  const settled = await Promise.all(
    picks.map(async (p): Promise<FetchedFile & { rate?: GithubError }> => {
      try {
        const raw = await client.getRaw(
          owner,
          repo,
          sha,
          p.path,
          MAX_FILE_BYTES
        );
        if (raw.truncated) {
          return {
            path: p.path,
            reason: p.reason,
            chars: 0,
            error: "file is larger than the size limit"
          };
        }
        if (looksBinary(raw.text)) {
          return {
            path: p.path,
            reason: p.reason,
            chars: 0,
            error: "binary file"
          };
        }
        return {
          path: p.path,
          reason: p.reason,
          text: raw.text,
          chars: raw.text.length
        };
      } catch (err) {
        if (err instanceof GithubError) {
          return {
            path: p.path,
            reason: p.reason,
            chars: 0,
            error:
              err.code === "RATE_LIMITED"
                ? "GitHub rate limit reached"
                : err.message,
            rate: err.code === "RATE_LIMITED" ? err : undefined
          };
        }
        return {
          path: p.path,
          reason: p.reason,
          chars: 0,
          error: "unexpected error"
        };
      }
    })
  );

  // Apply the total-size budget in priority order (picks are already ranked).
  let budget = remainingChars;
  const files: FetchedFile[] = [];
  let rateLimited: GithubError | undefined;
  for (const s of settled) {
    const { rate, ...file } = s;
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
