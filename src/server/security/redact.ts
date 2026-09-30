// Secret detection and redaction.
//
// Patterns are deliberately conservative: each matches a documented token
// format with a distinctive prefix or block marker, so false positives stay rare.

export interface SecretPattern {
  id: string;
  label: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "aws-access-key",
    label: "AWS access key ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    id: "github-token",
    label: "GitHub token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g
  },
  {
    id: "github-fine-grained",
    label: "GitHub fine-grained token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g
  },
  {
    id: "slack-token",
    label: "Slack token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    id: "openai-key",
    label: "OpenAI-style API key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g
  },
  {
    id: "private-key",
    label: "Private key block",
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g
  }
];

export const REDACTED = "[REDACTED]";

/** Keeps the first four characters so a reader can tell what was matched. */
function maskValue(value: string): string {
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}…${REDACTED}`;
}

/** Replace every recognised secret in a piece of text. Safe to log or store. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.regex.source, "g"), (m) =>
      maskValue(m)
    );
  }
  return out;
}

export interface SecretHit {
  patternId: string;
  label: string;
  /** 1-based line number. */
  line: number;
  /** Redacted excerpt of the matching line. */
  excerpt: string;
}

/**
 * Scan text for secret-shaped values. The returned excerpts are redacted.
 *
 * Each pattern is run once over the whole text (the regex engine is fast at
 * this), and line numbers are computed only for actual matches. This keeps the
 * cost low enough for a Workflow step on the Free plan (10 ms CPU).
 */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let lineStarts: number[] | undefined;

  const lineOf = (
    offset: number
  ): { line: number; start: number; end: number } => {
    if (!lineStarts) {
      lineStarts = [0];
      let i = text.indexOf("\n");
      while (i !== -1) {
        lineStarts.push(i + 1);
        i = text.indexOf("\n", i + 1);
      }
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const start = lineStarts[lo];
    const nl = text.indexOf("\n", start);
    return { line: lo + 1, start, end: nl === -1 ? text.length : nl };
  };

  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.regex.source, "g");
    for (const m of text.matchAll(re)) {
      const at = lineOf(m.index ?? 0);
      // Minified or generated lines are not scanned for excerpts.
      if (at.end - at.start > 2000) continue;
      hits.push({
        patternId: pattern.id,
        label: pattern.label,
        line: at.line,
        excerpt: redactSecrets(text.slice(at.start, at.end).trim()).slice(
          0,
          160
        )
      });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

const SECRET_KEY_NAME =
  /(secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|auth[_-]?key|credential)/i;

const PLACEHOLDER_VALUE =
  /^(?:|\s*|changeme|change-me|todo|xxx+|\*+|<[^>]*>|your[-_ ].*|example.*|placeholder.*|null|undefined|true|false|\$\{.*\}|\{\{.*\}\})$/i;

/** True when a config variable name suggests a secret. */
export function looksLikeSecretName(name: string): boolean {
  return SECRET_KEY_NAME.test(name);
}

/** True when a value is an obvious placeholder rather than a real secret. */
export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUE.test(value.trim());
}

/** Redact secrets in any string before it goes into a log line. */
export function safeForLog(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redactSecrets(text ?? "").slice(0, 500);
}
