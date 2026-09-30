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

export interface ScannedSource {
  path: string;
  /** Original text (line numbers refer to this). */
  text: string;
  /** Text with comments blanked out; same length and line structure. */
  code: string;
  exportedNames: Set<string>;
  hasStarExport: boolean;
  classes: ScannedClass[];
  importsAgentsSdk: boolean;
  usesCallable: boolean;
  envAiLine?: number;
  nodeImports: Array<{ spec: string; line: number }>;
}

/** Replace comments with spaces, keeping newlines so line numbers stay valid. */
export function stripComments(src: string): string {
  const n = src.length;
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");

  while (i < n) {
    const c = src.charCodeAt(i);
    // ' " `
    if (c === 39 || c === 34 || c === 96) {
      i = skipString(src, i, c);
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        let end = src.indexOf("\n", i);
        if (end === -1) end = n;
        parts.push(src.slice(last, i), blank(src.slice(i, end)));
        last = i = end;
        continue;
      }
      if (d === 42) {
        let end = src.indexOf("*/", i + 2);
        end = end === -1 ? n : end + 2;
        parts.push(src.slice(last, i), blank(src.slice(i, end)));
        last = i = end;
        continue;
      }
    }
    i++;
  }
  parts.push(src.slice(last));
  return parts.join("");
}

function skipString(src: string, start: number, quote: number): number {
  const n = src.length;
  let i = start + 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    // Plain quotes cannot span lines; stop so a stray quote (for example in a
    // regular expression) cannot swallow the rest of the file.
    if (c === 10 && quote !== 96) return i;
    i++;
  }
  return n;
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
  const lines = new LineIndex(code);

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
      line: lines.at(m.index ?? 0).line,
      exported: !!m[1] && !isDefault
    });
  }

  let envAiLine: number | undefined;
  const codeLines = code.split("\n");
  for (let i = 0; i < codeLines.length; i++) {
    if (codeLines[i].length < 2000 && ENV_AI.test(codeLines[i])) {
      envAiLine = i + 1;
      break;
    }
  }

  const nodeImports: Array<{ spec: string; line: number }> = [];
  for (const m of code.matchAll(NODE_IMPORT)) {
    nodeImports.push({ spec: m[1], line: lines.at(m.index ?? 0).line });
    if (nodeImports.length >= 20) break;
  }

  return {
    path,
    text,
    code,
    exportedNames,
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

export function isAgentClass(c: ScannedClass, src: ScannedSource): boolean {
  return AGENT_BASES.has(c.base) && src.importsAgentsSdk;
}
