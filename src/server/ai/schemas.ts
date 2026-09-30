import { z } from "zod";
import { MAX_AI_FINDINGS } from "../limits";

// The model's answer is treated as untrusted input: it must parse against this
// schema, and its evidence is then verified against the files it was shown.
// The same schema is converted to JSON Schema for Workers AI JSON mode, so the
// two can never drift apart.

const severity = z.enum(["critical", "high", "medium", "low", "info"]);

export const aiEvidenceSchema = z.object({
  path: z.string().max(300),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  excerpt: z.string().max(400).optional()
});

export const aiFindingSchema = z.object({
  severity,
  confidence: z.number().min(0).max(1),
  category: z.string().max(60),
  title: z.string().max(160),
  explanation: z.string().max(900),
  recommendation: z.string().max(600),
  evidence: z.array(aiEvidenceSchema).min(1).max(4)
});

export const aiPrioritySchema = z.object({
  /** Reference such as "R2", pointing at a rule finding listed in the prompt. */
  ref: z.string().max(10),
  why: z.string().max(300)
});

export const aiAnalysisSchema = z.object({
  summary: z.string().max(700),
  priorities: z.array(aiPrioritySchema).max(8),
  plan: z.array(z.string().max(300)).max(8),
  findings: z.array(aiFindingSchema).max(MAX_AI_FINDINGS)
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;
export type AiFindingRaw = z.infer<typeof aiFindingSchema>;

const VALIDATION_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "additionalProperties"
]);

/** Remove size and range keywords, keeping structure, types, enums and `required`. */
export function simplifySchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplifySchema);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (VALIDATION_KEYWORDS.has(k)) continue;
      out[k] = simplifySchema(v);
    }
    return out;
  }
  return node;
}

/**
 * JSON Schema for Workers AI `response_format`. Zod still enforces every limit
 * after the model answers, so `simplified` only loosens what the model is
 * asked to satisfy, never what is accepted.
 */
export function analysisJsonSchema(
  opts: { simplified?: boolean } = {}
): Record<string, unknown> {
  const schema = z.toJSONSchema(aiAnalysisSchema, { target: "draft-7" });
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  return opts.simplified
    ? (simplifySchema(rest) as Record<string, unknown>)
    : rest;
}

export type ParseOutcome =
  | { ok: true; value: AiAnalysis }
  | { ok: false; error: string };

/** Parse and validate model output. Accepts an object or a JSON string. */
export function parseAnalysis(raw: unknown): ParseOutcome {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    const text = stripCodeFence(raw.trim());
    try {
      candidate = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "invalid JSON";
      return { ok: false, error: `The output is not valid JSON (${detail}).` };
    }
  }
  const result = aiAnalysisSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    ok: false,
    error: `The output does not match the schema: ${issues}`
  };
}

/** Models sometimes wrap JSON in a Markdown fence despite instructions. */
export function stripCodeFence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  return m ? m[1] : text;
}
