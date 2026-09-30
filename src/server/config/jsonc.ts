import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError
} from "jsonc-parser";

// Thin wrapper over jsonc-parser that returns the parsed value together with
// a locator mapping a JSON path to a 1-based line number. Comments and
// trailing commas are accepted, as Wrangler and TypeScript both allow them.

export interface Loc {
  line: number;
  endLine: number;
}

export interface ConfigParseError {
  message: string;
  line: number;
  column: number;
}

export interface ParsedJsonc {
  value: unknown;
  errors: ConfigParseError[];
  /** Line of the value at a JSON path, or undefined if the path is absent. */
  locate(path: (string | number)[]): Loc | undefined;
  /** Line of a property's key at a JSON path (the line a reader would point to). */
  locateKey(path: (string | number)[]): Loc | undefined;
}

export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  /** 1-based line and column for a character offset. */
  at(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo] + 1 };
  }
}

export function parseJsonc(text: string): ParsedJsonc {
  const lines = new LineIndex(text);
  const raw: ParseError[] = [];
  const root: Node | undefined = parseTree(text, raw, {
    allowTrailingComma: true,
    disallowComments: false
  });

  const errors: ConfigParseError[] = raw.map((e) => {
    const pos = lines.at(e.offset);
    return {
      message: printParseErrorCode(e.error),
      line: pos.line,
      column: pos.column
    };
  });

  const toLoc = (node: Node): Loc => ({
    line: lines.at(node.offset).line,
    endLine: lines.at(Math.max(node.offset, node.offset + node.length - 1)).line
  });

  return {
    value: root ? getNodeValue(root) : undefined,
    errors,
    locate(path) {
      if (!root) return undefined;
      const node = findNodeAtLocation(root, path);
      return node ? toLoc(node) : undefined;
    },
    locateKey(path) {
      if (!root || path.length === 0) return undefined;
      const node = findNodeAtLocation(root, path);
      const prop = node?.parent;
      if (prop && prop.type === "property") return toLoc(prop);
      return node ? toLoc(node) : undefined;
    }
  };
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asStringArray(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === "string");
}
