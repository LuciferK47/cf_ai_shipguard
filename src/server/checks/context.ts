import { parsePackage } from "../config/package";
import { parseTsconfig } from "../config/tsconfig";
import { parseWrangler, type ParsedWrangler } from "../config/wrangler";
import { scanSource } from "./source";
import type { CheckContext } from "./types";

export interface ContextInput {
  base: string;
  /** Fetched file bodies keyed by repository-relative path. */
  files: ReadonlyMap<string, string>;
  paths: readonly string[];
  pathsComplete: boolean;
  neverFetched: readonly string[];
  otherProjects: readonly string[];
  /** Fetchable source files under the base, whether or not they were fetched. */
  sourceFileCount: number;
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function inBase(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}

export function buildContext(input: ContextInput): CheckContext {
  const { base, files } = input;

  const wranglerConfigs: ParsedWrangler[] = [];
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const path = inBase(base, name);
    const text = files.get(path);
    if (text !== undefined) wranglerConfigs.push(parseWrangler(path, text));
  }

  const pkgText = files.get(inBase(base, "package.json"));
  const tsText = files.get(inBase(base, "tsconfig.json"));

  const sources = [];
  for (const [path, text] of files) {
    if (CODE_EXT.test(path)) sources.push(scanSource(path, text));
  }

  return {
    base,
    files,
    paths: new Set(input.paths),
    pathsComplete: input.pathsComplete,
    neverFetched: input.neverFetched,
    otherProjects: input.otherProjects,
    wranglerConfigs,
    primary: wranglerConfigs.find((c) => c.ok),
    pkg:
      pkgText !== undefined
        ? parsePackage(inBase(base, "package.json"), pkgText)
        : undefined,
    tsconfig:
      tsText !== undefined
        ? parseTsconfig(inBase(base, "tsconfig.json"), tsText)
        : undefined,
    sources,
    coverage: {
      sourcesFetched: sources.length,
      sourcesTotal: Math.max(input.sourceFileCount, sources.length),
      complete: sources.length >= input.sourceFileCount && input.pathsComplete
    }
  };
}
