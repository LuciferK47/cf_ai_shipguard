import { redactSecrets } from "../security/redact";
import type { Evidence, Finding, Severity } from "../../shared/types";
import type { Loc } from "../config/jsonc";
import type { CheckContext } from "./types";

const MAX_EXCERPT_LINES = 4;
const MAX_EXCERPT_CHARS = 240;

/** A short, redacted excerpt of the given line range. */
export function excerptOf(
  text: string | undefined,
  loc?: Loc,
  maxLines = MAX_EXCERPT_LINES
): string | undefined {
  if (!text || !loc) return undefined;
  const lines = text.split("\n");
  const end = Math.min(loc.endLine, loc.line + maxLines - 1, lines.length);
  const slice = lines.slice(Math.max(0, loc.line - 1), end);
  if (slice.length === 0) return undefined;
  const joined = slice.map((l) => l.replace(/\s+$/, "")).join("\n");
  return redactSecrets(joined).slice(0, MAX_EXCERPT_CHARS);
}

/** Build evidence pointing at a location inside a fetched file. */
export function evidenceAt(
  ctx: Pick<CheckContext, "files">,
  path: string,
  loc?: Loc
): Evidence {
  if (!loc) return { path };
  return {
    path,
    lineStart: loc.line,
    lineEnd: Math.min(loc.endLine, loc.line + MAX_EXCERPT_LINES - 1),
    excerpt: excerptOf(ctx.files.get(path), loc)
  };
}

export interface RuleFindingInput {
  ruleId: string;
  /** What the finding is about; makes the fingerprint stable across audits. */
  subject: string;
  severity: Severity;
  confidence: number;
  category: string;
  title: string;
  explanation: string;
  recommendation: string;
  evidence: Evidence[];
  docsUrl: string;
}

export function ruleFinding(input: RuleFindingInput): Finding {
  return {
    fingerprint: `${input.ruleId}:${input.subject}`,
    ruleId: input.ruleId,
    source: "rule",
    severity: input.severity,
    confidence: input.confidence,
    category: input.category,
    title: input.title,
    explanation: input.explanation,
    recommendation: input.recommendation,
    evidence: input.evidence,
    docsUrl: input.docsUrl
  };
}

export const DOCS = {
  wrangler: "https://developers.cloudflare.com/workers/wrangler/configuration/",
  doExports:
    "https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/",
  doMigrationsLegacy:
    "https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/",
  secrets: "https://developers.cloudflare.com/workers/configuration/secrets/",
  aiBinding:
    "https://developers.cloudflare.com/workers-ai/configuration/bindings/",
  nodeCompat: "https://developers.cloudflare.com/workers/runtime-apis/nodejs/",
  environments:
    "https://developers.cloudflare.com/workers/wrangler/environments/",
  agentsSkill:
    "https://github.com/cloudflare/skills/blob/main/skills/agents-sdk/SKILL.md"
} as const;

/** Compare ISO dates (yyyy-mm-dd) lexicographically. */
export function dateBefore(a: string, b: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(a) && a < b;
}
