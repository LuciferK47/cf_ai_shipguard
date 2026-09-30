import { declaredDurableObjects } from "../config/wrangler";
import type { Finding } from "../../shared/types";
import { DOCS, evidenceAt, ruleFinding } from "./helpers";
import { isAgentClass } from "./source";
import type { CheckContext, Rule } from "./types";

function localBindings(ctx: CheckContext) {
  return (ctx.primary?.doBindings ?? []).filter((b) => !b.scriptName);
}

export const doNotDeclared: Rule = {
  id: "CF_DO_NOT_DECLARED",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const { live, deleted } = declaredDurableObjects(cfg);
    const usesExports = cfg.exports.some((e) => e.type === "durable-object");
    const out: Finding[] = [];

    for (const b of localBindings(ctx)) {
      if (live.has(b.className) || deleted.has(b.className)) continue;
      const flow = usesExports
        ? "The config uses the declarative `exports` map, but it has no entry for this class."
        : cfg.hasMigrationsKey
          ? "The config uses the legacy `migrations` array, but no migration creates this class."
          : "The config has neither an `exports` entry nor a migration for this class.";
      out.push(
        ruleFinding({
          ruleId: "CF_DO_NOT_DECLARED",
          subject: b.className,
          severity: "high",
          confidence: 0.9,
          category: "durable-objects",
          title: `Durable Object class \`${b.className}\` is bound but never declared`,
          explanation: `Binding \`${b.name}\` points at class \`${b.className}\`. ${flow} The Durable Objects docs say a Durable Object class must be declared (an \`exports\` entry, or a creating migration) before it can be used, so deploying this config is expected to fail or leave the binding unusable.`,
          recommendation:
            usesExports || !cfg.hasMigrationsKey
              ? `Add \`"exports": { "${b.className}": { "type": "durable-object", "storage": "sqlite" } }\`.`
              : `Add a migration with \`"new_sqlite_classes": ["${b.className}"]\` and a new unique tag.`,
          evidence: [evidenceAt(ctx, cfg.path, b.loc)],
          docsUrl:
            usesExports || !cfg.hasMigrationsKey
              ? DOCS.doExports
              : DOCS.doMigrationsLegacy
        })
      );
    }
    return out;
  }
};

export const doConfigMixed: Rule = {
  id: "CF_DO_CONFIG_MIXED",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const doExports = cfg.exports.filter((e) => e.type === "durable-object");
    if (
      !cfg.hasMigrationsKey ||
      cfg.migrations.length === 0 ||
      doExports.length === 0
    ) {
      return [];
    }
    return [
      ruleFinding({
        ruleId: "CF_DO_CONFIG_MIXED",
        subject: cfg.path,
        severity: "high",
        confidence: 0.95,
        category: "durable-objects",
        title: "Config mixes `migrations` and Durable Object `exports`",
        explanation:
          'The Durable Objects docs state: "You cannot use `migrations` and Durable Object entries in `exports` in the same Worker configuration." Wrangler validation fails for this combination.',
        recommendation:
          "Keep only `exports` (recommended for new Workers), converting each migration into an entry, or remove the Durable Object entries from `exports`.",
        evidence: [
          evidenceAt(ctx, cfg.path, cfg.migrations[0]?.loc),
          evidenceAt(ctx, cfg.path, doExports[0]?.loc)
        ],
        docsUrl: DOCS.doExports
      })
    ];
  }
};

export const doKvStorage: Rule = {
  id: "CF_DO_KV_STORAGE",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const { live } = declaredDurableObjects(cfg);
    const agentNames = new Set<string>();
    for (const src of ctx.sources) {
      for (const c of src.classes)
        if (isAgentClass(c, src)) agentNames.add(c.name);
    }

    const out: Finding[] = [];
    for (const [name, decl] of live) {
      if (decl.sqlite) continue;
      const isAgent = agentNames.has(name);
      out.push(
        ruleFinding({
          ruleId: "CF_DO_KV_STORAGE",
          subject: name,
          severity: isAgent ? "high" : "medium",
          confidence: isAgent ? 0.9 : 0.7,
          category: "durable-objects",
          title: `\`${name}\` uses the key-value storage backend`,
          explanation: `\`${name}\` is declared with ${
            decl.source === "exports"
              ? '`storage: "legacy-kv"`'
              : "`new_classes`"
          }, which creates a key-value-backed namespace. The Durable Objects docs say creating new key-value namespaces is no longer supported for accounts without an existing one, and that Cloudflare recommends SQLite for all new namespaces.${
            isAgent
              ? " This class extends a Cloudflare Agent, which persists its state and messages in SQLite."
              : " Ignore this if the namespace already exists in production."
          }`,
          recommendation:
            decl.source === "exports"
              ? `Use \`"storage": "sqlite"\` for \`${name}\`.`
              : `Declare \`${name}\` under \`new_sqlite_classes\` instead of \`new_classes\`.`,
          evidence: [evidenceAt(ctx, cfg.path, decl.loc)],
          docsUrl:
            decl.source === "exports" ? DOCS.doExports : DOCS.doMigrationsLegacy
        })
      );
    }
    return out;
  }
};

export const doDeletedButBound: Rule = {
  id: "CF_DO_DELETED_BUT_BOUND",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const { deleted } = declaredDurableObjects(cfg);
    const out: Finding[] = [];
    for (const b of localBindings(ctx)) {
      const d = deleted.get(b.className);
      if (!d) continue;
      out.push(
        ruleFinding({
          ruleId: "CF_DO_DELETED_BUT_BOUND",
          subject: b.className,
          severity: "high",
          confidence: 0.85,
          category: "durable-objects",
          title: `\`${b.className}\` is deleted but still bound`,
          explanation: `Binding \`${b.name}\` still points at \`${b.className}\`, which the config marks as deleted. The docs warn that deleting a class "removes its namespace and all of its stored data permanently".`,
          recommendation:
            "Remove the binding if the class is really being deleted, or remove the deletion if it is not.",
          evidence: [
            evidenceAt(ctx, cfg.path, b.loc),
            evidenceAt(ctx, cfg.path, d.loc)
          ],
          docsUrl:
            d.source === "exports" ? DOCS.doExports : DOCS.doMigrationsLegacy
        })
      );
    }
    return out;
  }
};

export const doDuplicateTag: Rule = {
  id: "CF_DO_DUPLICATE_TAG",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const seen = new Map<string, number>();
    const out: Finding[] = [];
    for (const m of cfg.migrations) {
      if (!m.tag) continue;
      const firstIdx = seen.get(m.tag);
      if (firstIdx === undefined) {
        seen.set(m.tag, m.index);
        continue;
      }
      out.push(
        ruleFinding({
          ruleId: "CF_DO_DUPLICATE_TAG",
          subject: m.tag,
          severity: "medium",
          confidence: 0.85,
          category: "durable-objects",
          title: `Migration tag "${m.tag}" is used more than once`,
          explanation:
            'The legacy migrations docs describe `tag` as the migration identifier and say it "should be unique for each migration entry". A repeated tag can make Wrangler treat a new migration as already applied.',
          recommendation:
            "Give every migration entry its own tag (v1, v2, ...).",
          evidence: [
            evidenceAt(
              ctx,
              cfg.path,
              cfg.migrations.find((x) => x.index === firstIdx)?.loc
            ),
            evidenceAt(ctx, cfg.path, m.loc)
          ],
          docsUrl: DOCS.doMigrationsLegacy
        })
      );
    }
    return out;
  }
};
