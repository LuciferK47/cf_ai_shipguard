import { MAX_AI_CALLS, RESERVED_OUTPUT_TOKENS } from "../limits";
import { classifyError, type LlmClient, LlmError } from "./llm";
import type { BuiltPrompt } from "./prompts";
import { analysisJsonSchema, parseAnalysis, type AiAnalysis } from "./schemas";

export type AnalysisOutcome =
  | {
      status: "ok";
      analysis: AiAnalysis;
      calls: number;
      /** True when the first answer was invalid and the second was accepted. */
      repaired: boolean;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    }
  | {
      status: "failed";
      code: "AI_UNAVAILABLE" | "AI_INVALID_OUTPUT";
      message: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    };

const PREVIOUS_ANSWER_CHARS = 1200;

function repairSuffix(previous: string | undefined, error: string): string {
  const shownPrevious = previous
    ? `\n\nYour previous reply (truncated, for reference only):\n${previous.slice(0, PREVIOUS_ANSWER_CHARS)}`
    : "";
  return `\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${error} Reply again with a single JSON object that matches the schema exactly, and nothing else.${shownPrevious}`;
}

/**
 * Ask the model for the analysis. At most `MAX_AI_CALLS` calls are made: the
 * first attempt, and one bounded repair attempt if the first failed in a way
 * that another try can fix. The result is never trusted here; the caller
 * verifies evidence separately.
 */
export async function runAnalysis(
  client: LlmClient,
  prompt: BuiltPrompt,
  maxCalls: number = MAX_AI_CALLS
): Promise<AnalysisOutcome> {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let previous: string | undefined;
  let lastError: LlmError = new LlmError(
    "AI_INVALID_OUTPUT",
    "No attempt was made."
  );
  let simplified = false;

  while (calls < maxCalls) {
    calls++;
    const suffix = calls > 1 ? repairSuffix(previous, lastError.message) : "";
    try {
      const res = await client.generateJson({
        system: prompt.system,
        user: prompt.user + suffix,
        schema: analysisJsonSchema({ simplified }),
        maxTokens: RESERVED_OUTPUT_TOKENS
      });
      inputTokens += res.inputTokens ?? 0;
      outputTokens += res.outputTokens ?? 0;
      latencyMs += res.latencyMs;

      const parsed = parseAnalysis(res.output);
      if (parsed.ok) {
        return {
          status: "ok",
          analysis: parsed.value,
          calls,
          repaired: calls > 1,
          inputTokens,
          outputTokens,
          latencyMs
        };
      }
      previous =
        typeof res.output === "string"
          ? res.output
          : JSON.stringify(res.output);
      lastError = new LlmError("AI_INVALID_OUTPUT", parsed.error, {
        retryable: true
      });
    } catch (err) {
      const e = classifyError(err);
      lastError = e;
      // A schema the model cannot satisfy is retried with looser size limits;
      // Zod still enforces every limit on whatever comes back.
      if (e.schemaFailure) simplified = true;
      if (!e.retryable) break;
    }
  }

  return {
    status: "failed",
    code: lastError.code,
    message: lastError.message,
    calls,
    inputTokens,
    outputTokens,
    latencyMs
  };
}
