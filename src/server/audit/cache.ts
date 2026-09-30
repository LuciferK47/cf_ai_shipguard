import { ANALYSIS_CACHE_TTL_SECONDS, PROMPT_VERSION } from "../limits";
import { aiAnalysisSchema, type AiAnalysis } from "../ai/schemas";

/** The slice of a KV namespace used for caching; lets tests pass a fake. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Content-addressed key: any change to the model, prompt version, instructions
 * or inputs (files, facts, rule findings) produces a new key, so a cached
 * analysis is only ever reused for exactly the same request.
 */
export async function analysisCacheKey(
  model: string,
  system: string,
  user: string
): Promise<string> {
  return `analysis:v${PROMPT_VERSION}:${await sha256Hex(`${model}\n${system}\n${user}`)}`;
}

/** Read a cached analysis. Anything unreadable or invalid is treated as a miss. */
export async function readCachedAnalysis(
  kv: KvLike | undefined,
  key: string
): Promise<AiAnalysis | undefined> {
  if (!kv) return undefined;
  try {
    const text = await kv.get(key);
    if (!text) return undefined;
    const parsed = aiAnalysisSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort: a cache failure must never fail an audit. */
export async function writeCachedAnalysis(
  kv: KvLike | undefined,
  key: string,
  analysis: AiAnalysis
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(analysis), {
      expirationTtl: ANALYSIS_CACHE_TTL_SECONDS
    });
  } catch {
    // ignored on purpose
  }
}
