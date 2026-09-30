import { LineIndex } from "../config/jsonc";

// Lightweight, comment-aware scanning of JavaScript and TypeScript source.
// This is deliberately not a full parser: it recognises a few declaration
// shapes reliably and reports how sure it is, rather than guessing.

export interface ScannedClass {
  name: string;
  base: string;
  line: number;
  exported: boolean;
}

/**
 * What the rules need to know about one source file. Deliberately small and
 * free of the file text, so scan results can be passed between Workflow steps.
 */
export interface ScannedSource {
  path: string;
  exportedNames: string[];
  hasStarExport: boolean;
  classes: ScannedClass[];
  importsAgentsSdk: boolean;
  usesCallable: boolean;
  envAiLine?: number;
  nodeImports: Array<{ spec: string; line: number }>;
}

// One alternation that matches, in source order, either a string literal (kept
// as is) or a comment (blanked). Running it through the regex engine is several
// times faster than walking the text in JavaScript. A quote that is never
// closed on its line matches nothing, so a stray quote (for example inside a
// regular expression) cannot swallow the rest of the file.
const STRING_OR_COMMENT =
  /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/** Replace comments with spaces, keeping newlines so line numbers stay valid. */
export function stripComments(src: string): string {
  if (!src.includes("/*") && !src.includes("//")) return src;
  return src.replace(STRING_OR_COMMENT, (m) => {
    const c = m.charCodeAt(0);
    if (c === 34 || c === 39 || c === 96) return m;
    return m.replace(/[^\n]/g, " ");
  });
}

const NAME = "[A-Za-z_$][\\w$]*";
const EXPORT_CLASS = new RegExp(
  `\\bexport\\s+(?:abstract\\s+)?class\\s+(${NAME})`,
  "g"
);
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
const STAR_EXPORT = /\bexport\s*\*\s*from\b/;
const CLASS_EXTENDS = new RegExp(
  `(\\bexport\\s+(?:default\\s+)?)?(?:abstract\\s+)?\\bclass\\s+(${NAME})(?:\\s*<[^>{]*>)?\\s+extends\\s+(${NAME}(?:\\.${NAME})*)`,
  "g"
);
const AGENTS_IMPORT =
  /from\s*["'](?:agents(?:\/[\w./-]+)?|@cloudflare\/(?:ai-chat|think|voice)(?:\/[\w./-]+)?)["']/;
const ENV_AI = /\b(?:this\.)?env(?:\.AI\b|\[\s*["']AI["']\s*\])/;
const NODE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](node:[\w/]+)["']/g;

export function scanSource(path: string, text: string): ScannedSource {
  const code = stripComments(text);
  let lines: LineIndex | undefined;
  const lineOf = (offset: number) =>
    (lines ??= new LineIndex(code)).at(offset).line;

  const exportedNames = new Set<string>();
  for (const m of code.matchAll(EXPORT_CLASS)) exportedNames.add(m[1]);
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(cleaned);
      const name = asMatch ? asMatch[1] : cleaned;
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
        exportedNames.add(name);
      }
    }
  }

  const classes: ScannedClass[] = [];
  for (const m of code.matchAll(CLASS_EXTENDS)) {
    const isDefault = /\bdefault\s*$/.test(m[1] ?? "");
    classes.push({
      name: m[2],
      base: m[3].split(".").pop() ?? m[3],
      line: lineOf(m.index ?? 0),
      exported: !!m[1] && !isDefault
    });
  }

  let envAiLine: number | undefined;
  const envAi = ENV_AI.exec(code);
  if (envAi) envAiLine = lineOf(envAi.index);

  const nodeImports: Array<{ spec: string; line: number }> = [];
  for (const m of code.matchAll(NODE_IMPORT)) {
    nodeImports.push({ spec: m[1], line: lineOf(m.index ?? 0) });
    if (nodeImports.length >= 20) break;
  }

  return {
    path,
    exportedNames: [...exportedNames],
    hasStarExport: STAR_EXPORT.test(code),
    classes,
    importsAgentsSdk: AGENTS_IMPORT.test(code),
    usesCallable: /@callable\s*\(/.test(code),
    envAiLine,
    nodeImports
  };
}

/** Base classes that make a class a Cloudflare Agent. */
export const AGENT_BASES: ReadonlySet<string> = new Set([
  "Agent",
  "AIChatAgent",
  "McpAgent",
  "Think"
]);

export function isAgentClass(
  c: ScannedClass,
  src: Pick<ScannedSource, "importsAgentsSdk">
): boolean {
  return AGENT_BASES.has(c.base) && src.importsAgentsSdk;
}
