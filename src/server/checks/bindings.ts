import { declaredDurableObjects } from "../config/wrangler";
import type { Finding } from "../../shared/types";
import { DOCS, evidenceAt, ruleFinding } from "./helpers";
import type { Rule } from "./types";

/**
 * A class named in a Durable Object binding, an `exports` entry or a Workflow
 * binding has to be exported by the Worker's code. Only the source files that
 * were actually fetched can be searched, so confidence depends on coverage.
 */
export const classNotExported: Rule = {
  id: "CF_CLASS_NOT_EXPORTED",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg || ctx.sources.length === 0) return [];
    // `export * from` can re-export any name, so absence proves nothing.
    if (ctx.sources.some((s) => s.hasStarExport)) return [];

    const exported = new Set<string>();
    for (const s of ctx.sources)
      for (const n of s.exportedNames) exported.add(n);

    interface Target {
      className: string;
      kind: "Durable Object" | "Workflow";
      loc: Parameters<typeof evidenceAt>[2];
    }
    const targets = new Map<string, Target>();
    for (const b of cfg.doBindings) {
      if (!b.scriptName)
        targets.set(b.className, {
          className: b.className,
          kind: "Durable Object",
          loc: b.loc
        });
    }
    for (const [name, decl] of declaredDurableObjects(cfg).live) {
      if (decl.source === "exports" && !targets.has(name)) {
        targets.set(name, {
          className: name,
          kind: "Durable Object",
          loc: decl.loc
        });
      }
    }
    for (const w of cfg.workflows) {
      if (!w.scriptName)
        targets.set(w.className, {
          className: w.className,
          kind: "Workflow",
          loc: w.loc
        });
    }

    const out: Finding[] = [];
    const { sourcesFetched, sourcesTotal, complete } = ctx.coverage;
    for (const t of targets.values()) {
      if (exported.has(t.className)) continue;
      out.push(
        ruleFinding({
          ruleId: "CF_CLASS_NOT_EXPORTED",
          subject: t.className,
          severity: complete ? "high" : "medium",
          confidence: complete ? 0.85 : 0.55,
          category: t.kind === "Workflow" ? "workflows" : "durable-objects",
          title: `${t.kind} class \`${t.className}\` is configured but not exported`,
          explanation: `The config refers to ${t.kind} class \`${t.className}\`, but no \`export class ${t.className}\` or \`export { ${t.className} }\` was found in the ${sourcesFetched} source file${sourcesFetched === 1 ? "" : "s"} ShipGuard inspected${
            complete
              ? ""
              : ` (of ${sourcesTotal} in the project, so it may be exported from a file that was not read)`
          }. The Wrangler docs describe \`class_name\` as the exported class name.`,
          recommendation: `Export \`${t.className}\` from the Worker's entry module (\`export class ${t.className} ...\`), or correct \`class_name\` in the config.`,
          evidence: [evidenceAt(ctx, cfg.path, t.loc)],
          docsUrl: DOCS.wrangler
        })
      );
    }
    return out;
  }
};

export const aiBindingMissing: Rule = {
  id: "CF_AI_BINDING_MISSING",
  run(ctx) {
    const cfg = ctx.primary;
    if (!cfg) return [];
    const usage = ctx.sources.find((s) => s.envAiLine !== undefined);
    if (!usage || usage.envAiLine === undefined) return [];
    if (cfg.aiBinding?.name === "AI") return [];
    // An environment may define the binding; without knowing which one is
    // deployed, stay silent rather than guess.
    if (cfg.envs.some((e) => e.keys.includes("ai"))) return [];

    const misnamed = cfg.aiBinding !== undefined;
    return [
      ruleFinding({
        ruleId: "CF_AI_BINDING_MISSING",
        subject: cfg.path,
        severity: "high",
        confidence: misnamed ? 0.85 : 0.9,
        category: "bindings",
        title: misnamed
          ? `Code uses \`env.AI\` but the AI binding is named \`${cfg.aiBinding?.name}\``
          : "Code uses `env.AI` but no Workers AI binding is configured",
        explanation: `\`${usage.path}\` reads \`env.AI\` (line ${usage.envAiLine}). The Workers AI docs configure the binding with \`"ai": { "binding": "AI" }\` and access it as \`env.AI\`.${
          misnamed
            ? ""
            : " Without it, `env.AI` is undefined at runtime and calls fail."
        }`,
        recommendation: `Add \`"ai": { "binding": "AI" }\` to the Wrangler config, then run \`wrangler types\`.`,
        evidence: [
          evidenceAt(ctx, usage.path, {
            line: usage.envAiLine,
            endLine: usage.envAiLine
          }),
          evidenceAt(
            ctx,
            cfg.path,
            cfg.aiBinding?.loc ?? { line: 1, endLine: 3 }
          )
        ],
        docsUrl: DOCS.aiBinding
      })
    ];
  }
};
