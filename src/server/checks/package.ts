import type { Finding } from "../../shared/types";
import { DOCS, evidenceAt, ruleFinding } from "./helpers";
import type { Rule } from "./types";

const CONFIG_FLAG = /(?:^|\s)(?:--config|-c)(?:=|\s+)(["']?)([^\s"']+)\1/;

function resolveRelative(base: string, target: string): string | undefined {
  const parts = [...(base ? base.split("/") : []), ...target.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

export const deployScriptConfigMissing: Rule = {
  id: "CF_DEPLOY_SCRIPT_CONFIG_MISSING",
  run(ctx) {
    const pkg = ctx.pkg;
    if (!pkg?.ok || !ctx.pathsComplete) return [];
    const out: Finding[] = [];
    for (const script of pkg.scripts) {
      if (!/\bwrangler\b/.test(script.command)) continue;
      const m = CONFIG_FLAG.exec(script.command);
      if (!m) continue;
      const target = m[2];
      if (/^[a-z]+:/i.test(target) || target.includes("$")) continue; // URL or shell variable
      const resolved = resolveRelative(ctx.base, target);
      if (!resolved || ctx.paths.has(resolved)) continue;
      out.push(
        ruleFinding({
          ruleId: "CF_DEPLOY_SCRIPT_CONFIG_MISSING",
          subject: `${pkg.path}#${script.name}`,
          severity: "medium",
          confidence: 0.85,
          category: "deployment",
          title: `Script \`${script.name}\` points at a Wrangler config that does not exist`,
          explanation: `\`${script.command}\` passes \`${target}\` as the config, but no such file exists in the repository at this commit.`,
          recommendation: `Fix the path in the \`${script.name}\` script, or commit the config file.`,
          evidence: [evidenceAt(ctx, pkg.path, script.loc)],
          docsUrl: DOCS.wrangler
        })
      );
    }
    return out;
  }
};

export const tsconfigDecorators: Rule = {
  id: "CF_TSCONFIG_DECORATORS",
  run(ctx) {
    const ts = ctx.tsconfig;
    if (!ts?.ok || ts.experimentalDecorators !== true) return [];
    if (ctx.pkg?.deps.agents === undefined) return [];
    const usesCallable = ctx.sources.some((s) => s.usesCallable);
    return [
      ruleFinding({
        ruleId: "CF_TSCONFIG_DECORATORS",
        subject: ts.path,
        severity: usesCallable ? "medium" : "low",
        confidence: 0.8,
        category: "agents",
        title:
          "`experimentalDecorators` is enabled in a project that uses the Agents SDK",
        explanation: `Cloudflare's Agents SDK guidance says not to enable \`experimentalDecorators\` because it breaks \`@callable\`.${
          usesCallable ? " This project uses `@callable`." : ""
        }`,
        recommendation:
          "Remove `experimentalDecorators` from tsconfig (extend `agents/tsconfig`, which is set up for the SDK's decorators).",
        evidence: [evidenceAt(ctx, ts.path, ts.experimentalDecoratorsLoc)],
        docsUrl: DOCS.agentsSkill
      })
    ];
  }
};
