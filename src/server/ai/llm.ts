import { MODEL_ID } from "../limits";
import { log } from "../log";

// The only place that talks to a model. Everything else depends on the small
// `LlmClient` interface, so tests and evals can supply a fake or a REST client.

export type LlmErrorCode = "AI_UNAVAILABLE" | "AI_INVALID_OUTPUT";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** True when trying once more may help (capacity, transient failure). */
  readonly retryable: boolean;
  /** True when the failure is the model not satisfying the JSON schema. */
  readonly schemaFailure: boolean;

  constructor(
    code: LlmErrorCode,
    message: string,
    opts: { retryable?: boolean; schemaFailure?: boolean } = {}
  ) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.schemaFailure = opts.schemaFailure ?? false;
  }
}

export interface LlmRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface LlmResponse {
  /** Parsed object or raw string; validated by the caller. */
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export interface LlmClient {
  readonly model: string;
  generateJson(req: LlmRequest): Promise<LlmResponse>;
}

/** Turn any thrown value from a model call into a classified `LlmError`. */
export function classifyError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/json mode|couldn't be met|schema/i.test(message)) {
    return new LlmError(
      "AI_INVALID_OUTPUT",
      "The model could not satisfy the JSON schema.",
      {
        schemaFailure: true,
        retryable: true
      }
    );
  }
  if (
    /neuron|quota|daily|allocation|4006|rate.?limit|too many requests|429/i.test(
      message
    )
  ) {
    return new LlmError(
      "AI_UNAVAILABLE",
      "The Workers AI allocation for this account looks exhausted. Deterministic results are still shown."
    );
  }
  if (
    /capacity|overloaded|temporar|timeout|timed out|503|502|504|3040/i.test(
      message
    )
  ) {
    return new LlmError(
      "AI_UNAVAILABLE",
      "Workers AI is temporarily unavailable.",
      {
        retryable: true
      }
    );
  }
  return new LlmError("AI_UNAVAILABLE", "The model call failed.", {
    retryable: false
  });
}

interface RunResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toResponse(result: RunResult, started: number): LlmResponse {
  const output = result.response;
  if (output === undefined || output === null || output === "") {
    throw new LlmError(
      "AI_INVALID_OUTPUT",
      "The model returned an empty response.",
      {
        retryable: true
      }
    );
  }
  return {
    output,
    inputTokens: result.usage?.prompt_tokens,
    outputTokens: result.usage?.completion_tokens,
    latencyMs: Date.now() - started
  };
}

/** Workers AI through the `AI` binding, optionally routed via AI Gateway. */
export function createWorkersAiClient(
  ai: Ai,
  opts: { gatewayId?: string } = {}
): LlmClient {
  return {
    model: MODEL_ID,
    async generateJson(req) {
      const started = Date.now();
      const body = {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user }
        ],
        response_format: { type: "json_schema", json_schema: req.schema },
        max_tokens: req.maxTokens,
        temperature: 0.1
      };
      try {
        // The binding's static types do not describe JSON mode for every model.
        // Called as a method (not detached) so it also works on an RPC stub.
        const binding = ai as unknown as {
          run(
            model: string,
            inputs: unknown,
            options?: unknown
          ): Promise<RunResult>;
        };
        const result = await binding.run(
          MODEL_ID,
          body,
          opts.gatewayId ? { gateway: { id: opts.gatewayId } } : undefined
        );
        return toResponse(result, started);
      } catch (err) {
        // The classified error is deliberately generic; keep the cause in the logs.
        log("ai.error", {
          message: err instanceof Error ? err.message : String(err)
        });
        throw classifyError(err);
      }
    }
  };
}

/**
 * Workers AI over the public REST API. Used by `npm run eval:llm`, which runs
 * outside a Worker and therefore has no binding.
 */
export function createRestLlmClient(opts: {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
}): LlmClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    model: MODEL_ID,
    async generateJson(req) {
      const started = Date.now();
      let res: Response;
      try {
        res = await doFetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/ai/run/${MODEL_ID}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${opts.apiToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messages: [
                { role: "system", content: req.system },
                { role: "user", content: req.user }
              ],
              response_format: { type: "json_schema", json_schema: req.schema },
              max_tokens: req.maxTokens,
              temperature: 0.1
            }),
            signal: AbortSignal.timeout(120_000)
          }
        );
      } catch (err) {
        throw classifyError(err);
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw classifyError(new Error(`HTTP ${res.status}: ${text}`));
      }
      const body = (await res.json()) as {
        result?: RunResult;
        success?: boolean;
      };
      if (!body.result)
        throw new LlmError("AI_INVALID_OUTPUT", "The API returned no result.");
      return toResponse(body.result, started);
    }
  };
}
