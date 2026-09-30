// Central resource budgets.
//
// Cloudflare Workflows on the Free plan allow 50 subrequests per instance and
// 10 ms of CPU per step (https://developers.cloudflare.com/workflows/reference/limits/).
// Everything here is sized so that one audit stays well under those caps, and
// so that a retried step cannot exhaust the subrequest budget.

/** Subrequests available to one workflow instance on the Free plan. */
export const FREE_SUBREQUEST_CAP = 50;

/** GitHub REST calls per audit: repository, commit SHA, tree. */
export const GITHUB_API_CALLS = 3;

/** Raw file fetches per audit (configuration files plus source files). */
export const MAX_FILES_FETCHED = 20;

/** Workers AI calls per audit: analysis, and at most one repair attempt. */
export const MAX_AI_CALLS = 2;

/** KV reads and writes for the analysis cache. */
export const KV_CALLS = 2;

/** Agent RPC calls made by the workflow (progress, persist, complete). */
export const AGENT_RPC_CALLS_RESERVED = 6;

export const PLANNED_SUBREQUESTS =
  GITHUB_API_CALLS +
  MAX_FILES_FETCHED +
  MAX_AI_CALLS +
  KV_CALLS +
  AGENT_RPC_CALLS_RESERVED;

/** Individual file size limit, bytes. Larger files are skipped, not truncated. */
export const MAX_FILE_BYTES = 100_000;

/** Total characters retrieved across all files in one audit. */
export const MAX_TOTAL_CHARS = 400_000;

/** Files listed in the tree beyond this count are ignored. */
export const MAX_TREE_ENTRIES = 20_000;

/** Timeout for one outbound GitHub request. */
export const GITHUB_TIMEOUT_MS = 10_000;

// Workers AI Llama 3.3 has a 24,000 token context window.
// https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
export const MODEL_CONTEXT_TOKENS = 24_000;
export const RESERVED_OUTPUT_TOKENS = 2_000;
export const PROMPT_OVERHEAD_TOKENS = 2_000;
export const FINDINGS_CONTEXT_TOKENS = 2_500;
/** Token budget for file blocks placed in the analysis prompt. */
export const FILE_CONTEXT_TOKENS = 11_000;
/** Rough estimate used for budgeting only. */
export const CHARS_PER_TOKEN = 3.2;

export const MAX_AI_FINDINGS = 6;

export const MAX_CHAT_MESSAGE_CHARS = 4_000;
export const MAX_URL_CHARS = 300;
export const MAX_PERSISTED_MESSAGES = 200;

/** Audits kept per target before pruning. */
export const MAX_AUDITS_PER_TARGET = 20;
export const MAX_RECENT_IN_STATE = 10;
export const MAX_TARGETS = 10;

/** Per-workspace audit rate limit. */
export const MAX_AUDITS_PER_HOUR = 10;

/** A running audit older than this is reconciled against the workflow status. */
export const STALE_AUDIT_MS = 2 * 60 * 1000;

/** Analysis cache time to live, seconds. */
export const ANALYSIS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Bump when the prompt or output schema changes so cached results are not reused. */
export const PROMPT_VERSION = "1";

export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
