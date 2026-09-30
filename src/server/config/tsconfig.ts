import { asRecord, parseJsonc, type ConfigParseError, type Loc } from "./jsonc";

export interface ParsedTsconfig {
  path: string;
  ok: boolean;
  errors: ConfigParseError[];
  experimentalDecorators?: boolean;
  experimentalDecoratorsLoc?: Loc;
}

/** tsconfig.json allows comments and trailing commas, like JSONC. */
export function parseTsconfig(path: string, text: string): ParsedTsconfig {
  const parsed = parseJsonc(text);
  const root = asRecord(parsed.value);
  if (parsed.errors.length > 0 || !root) {
    return { path, ok: false, errors: parsed.errors };
  }
  const opts = asRecord(root.compilerOptions);
  const flag = opts?.experimentalDecorators;
  return {
    path,
    ok: true,
    errors: [],
    experimentalDecorators: typeof flag === "boolean" ? flag : undefined,
    experimentalDecoratorsLoc: parsed.locateKey([
      "compilerOptions",
      "experimentalDecorators"
    ])
  };
}
