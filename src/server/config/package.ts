import {
  asRecord,
  asString,
  parseJsonc,
  type ConfigParseError,
  type Loc
} from "./jsonc";

export interface ParsedPackage {
  path: string;
  ok: boolean;
  errors: ConfigParseError[];
  name?: string;
  /** dependencies, devDependencies and peerDependencies merged. */
  deps: Record<string, string>;
  scripts: Array<{ name: string; command: string; loc?: Loc }>;
}

export function parsePackage(path: string, text: string): ParsedPackage {
  const parsed = parseJsonc(text);
  const root = asRecord(parsed.value);
  if (parsed.errors.length > 0 || !root) {
    return { path, ok: false, errors: parsed.errors, deps: {}, scripts: [] };
  }
  const deps: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const rec = asRecord(root[field]);
    if (!rec) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "string") deps[k] = v;
    }
  }
  const scripts: ParsedPackage["scripts"] = [];
  const scriptsRec = asRecord(root.scripts);
  if (scriptsRec) {
    for (const [name, command] of Object.entries(scriptsRec)) {
      if (typeof command === "string") {
        scripts.push({
          name,
          command,
          loc: parsed.locateKey(["scripts", name])
        });
      }
    }
  }
  return {
    path,
    ok: true,
    errors: [],
    name: asString(root.name),
    deps,
    scripts
  };
}
