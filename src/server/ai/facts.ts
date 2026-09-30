import { declaredDurableObjects } from "../config/wrangler";
import type { CheckContext } from "../checks/types";
import { isAgentClass } from "../checks/source";

/**
 * Plain-language facts extracted by code, given to the model so it does not
 * have to re-derive them (and cannot misread them). Each line is checkable.
 */
export function describeFacts(ctx: CheckContext): string[] {
  const facts: string[] = [];
  const cfg = ctx.primary;

  facts.push(
    `Project directory: ${ctx.base === "" ? "(repository root)" : ctx.base}`
  );
  if (ctx.wranglerConfigs.length === 0) {
    facts.push("No Wrangler configuration file was found.");
  } else if (!cfg) {
    facts.push("A Wrangler configuration exists but could not be parsed.");
  } else {
    facts.push(`Wrangler config: ${cfg.path}`);
    if (cfg.name) facts.push(`Worker name: ${cfg.name}`);
    if (cfg.main) facts.push(`Entry point (main): ${cfg.main}`);
    facts.push(`compatibility_date: ${cfg.compatibilityDate ?? "(not set)"}`);
    if (cfg.compatibilityFlags.length > 0) {
      facts.push(`compatibility_flags: ${cfg.compatibilityFlags.join(", ")}`);
    }
    facts.push(
      `Workers AI binding: ${cfg.aiBinding ? cfg.aiBinding.name : "(none)"}`
    );
    for (const b of cfg.doBindings) {
      facts.push(
        `Durable Object binding ${b.name} -> class ${b.className}${b.scriptName ? ` (external script ${b.scriptName})` : ""}`
      );
    }
    const { live, deleted } = declaredDurableObjects(cfg);
    for (const [name, decl] of live) {
      facts.push(
        `Durable Object class ${name} declared via ${decl.source} (${decl.sqlite ? "SQLite" : "key-value"} storage)`
      );
    }
    for (const name of deleted.keys())
      facts.push(`Durable Object class ${name} is marked deleted`);
    for (const w of cfg.workflows)
      facts.push(`Workflow binding ${w.binding} -> class ${w.className}`);
    if (cfg.envs.length > 0) {
      facts.push(
        `Wrangler environments: ${cfg.envs.map((e) => e.name).join(", ")}`
      );
    }
  }

  if (ctx.pkg?.ok) {
    const notable = [
      "agents",
      "@cloudflare/ai-chat",
      "wrangler",
      "hono",
      "vite",
      "react"
    ].filter((d) => ctx.pkg?.deps[d] !== undefined);
    if (notable.length > 0)
      facts.push(`Notable dependencies: ${notable.join(", ")}`);
  }

  const agents = ctx.sources.flatMap((s) =>
    s.classes
      .filter((c) => isAgentClass(c, s))
      .map((c) => `${c.name} (${s.path}:${c.line})`)
  );
  if (agents.length > 0)
    facts.push(`Agent classes found in source: ${agents.join(", ")}`);
  if (ctx.otherProjects.length > 0) {
    facts.push(
      `Other Wrangler projects in the repository: ${ctx.otherProjects.join(", ")}`
    );
  }
  return facts;
}
