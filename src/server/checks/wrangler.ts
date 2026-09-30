import {
  isPlaceholderValue,
  looksLikeSecretName,
  SECRET_PATTERNS
} from "../security/redact";
import { resolveMainPath } from "../ingest/select";
import type { Finding } from "../../shared/types";
import { DOCS, dateBefore, evidenceAt, ruleFinding } from "./helpers";
import type { Rule } from "./types";

/** Keys the Wrangler docs say environments do not inherit. */
export const NON_INHERITABLE_KEYS = [
  "define",
  "vars",
  "durable_objects",
  "kv_namespaces",
  "r2_buckets",
  "ai_search_namespaces",
  "ai_search",
  "vectorize",
  "services",
  "queues",
  "workflows",
  "tail_consumers",
  "secrets",
  "secrets_store_secrets"
] as const;

/** Node.js APIs are on by default from this compatibility date. */
export const NODEJS_COMPAT_DEFAULT_DATE = "2026-08-04";

export const configNotFound: Rule = {
  id: "CF_CONFIG_NOT_FOUND",
  run(ctx) {
    if (ctx.wranglerConfigs.length > 0) return [];
    const hasWranglerDep = ctx.pkg?.deps.wrangler !== undefined;
    const where = ctx.base === "" ? "the repository root" : `\`${ctx.base}\``;
    const others =
      ctx.otherProjects.length > 0
        ? ` Other directories with a Wrangler config: ${ctx.otherProjects
            .slice(0, 5)
            .map((p) => `\`${p || "."}\``)
            .join(", ")}.`
        : "";
    return [
      ruleFinding({
        ruleId: "CF_CONFIG_NOT_FOUND",
        subject: ctx.base || ".",
        severity: hasWranglerDep ? "medium" : "info",
        confidence: ctx.pathsComplete ? 0.9 : 0.6,
        category: "configuration",
        title: "No Wrangler configuration found",
        explanation: `No wrangler.jsonc, wrangler.json or wrangler.toml exists in ${where}.${
          hasWranglerDep
            ? " The package depends on wrangler, so a config is probably expected."
            : " If this project deploys with Pages, the dashboard, or another tool, this is expected."
        }${others}`,
        recommendation:
          "Add a Wrangler configuration, or point ShipGuard at the directory that contains it with a /tree/{ref}/{path} URL.",
        evidence:
          hasWranglerDep && ctx.pkg ? [evidenceAt(ctx, ctx.pkg.path)] : [],
        docsUrl: DOCS.wrangler
      })
    ];
  }
};

export const configParseError: Rule = {
  id: "CF_CONFIG_PARSE_ERROR",
  run(ctx) {
    const out: Finding[] = [];
    for (const cfg of ctx.wranglerConfigs) {
      if (cfg.ok) continue;
      const first = cfg.errors[0];
      // Parsers report where the next token starts, so a missing comma or brace
      // is really on the previous line; include it in the excerpt.
      const loc = first
        ? { line: Math.max(1, first.line - 1), endLine: first.line }
        : undefined;
      out.push(
        ruleFinding({
          ruleId: "CF_CONFIG_PARSE_ERROR",
          subject: cfg.path,
          severity: "high",
          confidence: 0.95,
          category: "configuration",
          title: `${cfg.path} cannot be parsed`,
          explanation: first
            ? `${first.message} at line ${first.line}, column ${first.column}. Configuration-dependent checks were skipped for this file.`
            : "The file could not be parsed. Configuration-dependent checks were skipped for this file.",
          recommendation:
            "Fix the syntax error, then run `npx wrangler deploy --dry-run` to confirm the config is valid.",
          evidence: [evidenceAt(ctx, cfg.path, loc)],
          docsUrl: DOCS.wrangler
        })
      );
    }
    return out;
  }
};

export const compatDateMissing: Rule = {
  id: "CF_COMPAT_DATE_MISSING",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg || cfg.compatibilityDate) return [];
    return [
      ruleFinding({
        ruleId: "CF_COMPAT_DATE_MISSING",
        subject: cfg.path,
        severity: "high",
        confidence: 0.9,
        category: "configuration",
        title: "compatibility_date is not set",
        explanation:
          "The Wrangler docs state that `compatibility_date` is required. It selects the Workers runtime behaviour your code runs against.",
        recommendation:
          'Add `"compatibility_date": "<today\'s date>"` (yyyy-mm-dd) to the config.',
        evidence: [evidenceAt(ctx, cfg.path, { line: 1, endLine: 3 })],
        docsUrl: DOCS.wrangler
      })
    ];
  }
};

export const mainNotFound: Rule = {
  id: "CF_MAIN_NOT_FOUND",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg?.main || !ctx.pathsComplete) return [];
    const target = resolveMainPath(cfg.path, cfg.main);
    if (!target || ctx.paths.has(target)) return [];

    // A source file with the same stem (index.js vs index.ts) means the entry
    // exists in another form; do not guess which one Wrangler will build.
    const stem = target.replace(/\.[cm]?[jt]sx?$/, "");
    for (const p of ctx.paths) {
      if (p.startsWith(`${stem}.`)) return [];
    }

    const generated = /(?:^|\/)(?:dist|build|out|\.output)\//.test(target);
    return [
      ruleFinding({
        ruleId: "CF_MAIN_NOT_FOUND",
        subject: cfg.path,
        severity: generated ? "info" : "medium",
        confidence: generated ? 0.5 : 0.85,
        category: "configuration",
        title: `Worker entry point \`${cfg.main}\` is not in the repository`,
        explanation: generated
          ? `\`main\` points into a build output directory, which is normally not committed. This is expected if a build step produces it before deploy.`
          : `\`main\` is set to \`${cfg.main}\` but no such file exists in the repository at this commit.`,
        recommendation: generated
          ? "Make sure the build runs before `wrangler deploy`."
          : "Correct the `main` path, or commit the file.",
        evidence: [evidenceAt(ctx, cfg.path, cfg.mainLoc)],
        docsUrl: DOCS.wrangler
      })
    ];
  }
};

export const envNotInherited: Rule = {
  id: "CF_ENV_NOT_INHERITED",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg || cfg.envs.length === 0) return [];
    const topLevel = NON_INHERITABLE_KEYS.filter((k) =>
      cfg.topLevelKeys.includes(k)
    );
    if (topLevel.length === 0) return [];

    const out: Finding[] = [];
    for (const env of cfg.envs) {
      const missing = topLevel.filter((k) => !env.keys.includes(k));
      if (missing.length === 0) continue;
      out.push(
        ruleFinding({
          ruleId: "CF_ENV_NOT_INHERITED",
          subject: `${cfg.path}#${env.name}`,
          severity: "medium",
          confidence: 0.6,
          category: "configuration",
          title: `Environment "${env.name}" does not redefine ${missing
            .map((m) => `\`${m}\``)
            .join(", ")}`,
          explanation: `The Wrangler docs say non-inheritable keys "cannot be inherited by environments and must be specified for each environment". The top level defines ${missing
            .map((m) => `\`${m}\``)
            .join(
              ", "
            )}, but \`env.${env.name}\` does not, so deploying that environment will not get them. This is only a problem if the environment is meant to have them.`,
          recommendation: `Copy the needed entries into \`env.${env.name}\`, or confirm the environment intentionally omits them.`,
          evidence: [evidenceAt(ctx, cfg.path, env.loc)],
          docsUrl: DOCS.environments
        })
      );
    }
    return out;
  }
};

export const nodejsCompatMissing: Rule = {
  id: "CF_NODEJS_COMPAT_MISSING",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg?.compatibilityDate) return [];
    if (!dateBefore(cfg.compatibilityDate, NODEJS_COMPAT_DEFAULT_DATE))
      return [];
    if (cfg.compatibilityFlags.some((f) => f.startsWith("nodejs_"))) return [];

    for (const src of ctx.sources) {
      const hit = src.nodeImports[0];
      if (!hit) continue;
      return [
        ruleFinding({
          ruleId: "CF_NODEJS_COMPAT_MISSING",
          subject: cfg.path,
          severity: "medium",
          confidence: 0.75,
          category: "compatibility",
          title: "Node.js built-ins are imported without nodejs_compat",
          explanation: `\`${src.path}\` imports \`${hit.spec}\`, but the config has compatibility_date ${cfg.compatibilityDate} and no \`nodejs_compat\` flag. The Node.js compatibility docs say that for dates from 2024-09-23 through 2026-08-03 the flag must be added; from ${NODEJS_COMPAT_DEFAULT_DATE} it is enabled by default.`,
          recommendation:
            'Add `"compatibility_flags": ["nodejs_compat"]`, or move `compatibility_date` to 2026-08-04 or later.',
          evidence: [
            evidenceAt(ctx, src.path, { line: hit.line, endLine: hit.line }),
            evidenceAt(ctx, cfg.path, cfg.compatibilityDateLoc)
          ],
          docsUrl: DOCS.nodeCompat
        })
      ];
    }
    return [];
  }
};

export const secretInVars: Rule = {
  id: "CF_SECRET_IN_VARS",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const out: Finding[] = [];
    for (const v of cfg.vars) {
      if (typeof v.value !== "string" || isPlaceholderValue(v.value)) continue;
      const namedLikeSecret = looksLikeSecretName(v.key) && v.value.length >= 8;
      const shapedLikeSecret = SECRET_PATTERNS.some((p) =>
        new RegExp(p.regex.source).test(v.value as string)
      );
      if (!namedLikeSecret && !shapedLikeSecret) continue;

      // Never quote the value: point at the line and describe it instead.
      const loc = v.loc;
      out.push(
        ruleFinding({
          ruleId: "CF_SECRET_IN_VARS",
          subject: `${cfg.path}#${v.key}`,
          severity: shapedLikeSecret ? "critical" : "high",
          confidence: shapedLikeSecret ? 0.95 : 0.75,
          category: "security",
          title: `\`vars.${v.key}\` looks like a secret committed to the config`,
          explanation: `\`${v.key}\` is set to a literal value in \`vars\`, and its ${
            shapedLikeSecret
              ? "value matches a known credential format"
              : "name suggests a credential"
          }. The Workers docs say: "Do not use \`vars\` to store sensitive information in your Worker's Wrangler configuration file. Use secrets instead."`,
          recommendation: `Remove the value from the config, rotate it if it was ever real, and store it with \`wrangler secret put ${v.key}\`.`,
          evidence: loc
            ? [
                {
                  path: cfg.path,
                  lineStart: loc.line,
                  lineEnd: loc.line,
                  excerpt: `${v.key}: [REDACTED]`
                }
              ]
            : [{ path: cfg.path }],
          docsUrl: DOCS.secrets
        })
      );
    }
    return out;
  }
};
