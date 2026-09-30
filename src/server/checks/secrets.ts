import { findSecrets } from "../security/redact";
import type { Finding } from "../../shared/types";
import { DOCS, ruleFinding } from "./helpers";
import type { Rule } from "./types";

const EXAMPLE_DIRS =
  /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|examples?|docs?|samples?)\//i;

export const secretPattern: Rule = {
  id: "CF_SECRET_PATTERN",
  run(ctx) {
    const out: Finding[] = [];
    for (const [path, text] of ctx.files) {
      const hits = findSecrets(text);
      if (hits.length === 0) continue;

      const byPattern = new Map<string, typeof hits>();
      for (const h of hits) {
        const list = byPattern.get(h.patternId) ?? [];
        list.push(h);
        byPattern.set(h.patternId, list);
      }
      const inExample = EXAMPLE_DIRS.test(path);
      for (const [patternId, list] of byPattern) {
        out.push(
          ruleFinding({
            ruleId: "CF_SECRET_PATTERN",
            subject: `${path}:${patternId}`,
            severity: inExample ? "medium" : "critical",
            confidence: inExample ? 0.5 : 0.9,
            category: "security",
            title: `${list[0].label} committed in \`${path}\``,
            explanation: `${list.length} line${list.length === 1 ? "" : "s"} in this file match the ${list[0].label} format.${
              inExample
                ? " The file is under a test, fixture or example directory, so this may be a dummy value."
                : ""
            } Values are redacted in this report.`,
            recommendation:
              "Treat the credential as compromised: revoke and rotate it, remove it from the repository history, and keep the replacement in a Worker secret (`wrangler secret put`).",
            evidence: list.slice(0, 3).map((h) => ({
              path,
              lineStart: h.line,
              lineEnd: h.line,
              excerpt: h.excerpt
            })),
            docsUrl: DOCS.secrets
          })
        );
      }
    }
    return out;
  }
};

export const envFileCommitted: Rule = {
  id: "CF_ENV_FILE_COMMITTED",
  run(ctx) {
    return ctx.neverFetched.map((path) =>
      ruleFinding({
        ruleId: "CF_ENV_FILE_COMMITTED",
        subject: path,
        severity: "high",
        confidence: 0.9,
        category: "security",
        title: `\`${path}\` is committed to the repository`,
        explanation: `The Workers docs say "The \`.dev.vars\` and \`.env\` files should not be committed to git." This file exists in the repository tree. ShipGuard never downloads such files, so its contents were not inspected.`,
        recommendation:
          "Remove the file from version control, add `.dev.vars*` and `.env*` to .gitignore, and rotate any secret it held. Commit a `.dev.vars.example` with placeholders instead.",
        evidence: [{ path }],
        docsUrl: DOCS.secrets
      })
    );
  }
};
