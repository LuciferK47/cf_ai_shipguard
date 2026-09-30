import { parse as parseToml, TomlError } from "smol-toml";
import {
  asArray,
  asRecord,
  asString,
  asStringArray,
  LineIndex,
  parseJsonc,
  type ConfigParseError,
  type Loc
} from "./jsonc";

// Normalises a Wrangler configuration (JSON, JSONC or TOML) into one model the
// rules can inspect. Field names follow
// https://developers.cloudflare.com/workers/wrangler/configuration/

export interface DoBinding {
  name: string;
  className: string;
  scriptName?: string;
  loc?: Loc;
}

export interface Migration {
  index: number;
  tag: string;
  newClasses: string[];
  newSqliteClasses: string[];
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
  transferredTo: string[];
  loc?: Loc;
  /** Line of each class name string, for pointing evidence at the exact entry. */
  classLocs: Record<string, Loc>;
}

export interface WorkflowBinding {
  name: string;
  binding: string;
  className: string;
  scriptName?: string;
  loc?: Loc;
}

/** An entry of the declarative `exports` map (the current Durable Object lifecycle config). */
export interface ExportEntry {
  name: string;
  type: string;
  storage?: string;
  state?: string;
  renamedTo?: string;
  loc?: Loc;
}

export interface VarEntry {
  key: string;
  value: unknown;
  loc?: Loc;
}

export interface EnvSection {
  name: string;
  keys: string[];
  loc?: Loc;
}

export interface ParsedWrangler {
  path: string;
  format: "jsonc" | "toml";
  /** False when the file could not be parsed; rules must not trust the rest. */
  ok: boolean;
  errors: ConfigParseError[];
  name?: string;
  main?: string;
  mainLoc?: Loc;
  compatibilityDate?: string;
  compatibilityDateLoc?: Loc;
  compatibilityFlags: string[];
  compatibilityFlagsLoc?: Loc;
  aiBinding?: { name: string; loc?: Loc };
  doBindings: DoBinding[];
  migrations: Migration[];
  workflows: WorkflowBinding[];
  exports: ExportEntry[];
  /** True when the config has a `migrations` key (legacy Durable Object flow). */
  hasMigrationsKey: boolean;
  vars: VarEntry[];
  varsLoc?: Loc;
  envs: EnvSection[];
  /** Top-level keys present in the file. */
  topLevelKeys: string[];
  assetsDirectory?: string;
}

const EMPTY: Omit<ParsedWrangler, "path" | "format" | "ok" | "errors"> = {
  compatibilityFlags: [],
  doBindings: [],
  migrations: [],
  workflows: [],
  exports: [],
  hasMigrationsKey: false,
  vars: [],
  envs: [],
  topLevelKeys: []
};

export function isWranglerPath(path: string): boolean {
  return /(?:^|\/)wrangler\.(?:jsonc?|toml)$/.test(path);
}

export function parseWrangler(path: string, text: string): ParsedWrangler {
  return path.endsWith(".toml")
    ? parseTomlConfig(path, text)
    : parseJsoncConfig(path, text);
}

function parseJsoncConfig(path: string, text: string): ParsedWrangler {
  const parsed = parseJsonc(text);
  const base = { path, format: "jsonc" as const, errors: parsed.errors };
  const root = asRecord(parsed.value);
  if (parsed.errors.length > 0 || !root) {
    if (!root && parsed.errors.length === 0) {
      return {
        ...EMPTY,
        ...base,
        ok: false,
        errors: [
          {
            message: "The configuration must be a JSON object",
            line: 1,
            column: 1
          }
        ]
      };
    }
    return { ...EMPTY, ...base, ok: false };
  }

  const cfg = normalise(root, {
    key: (p) => parsed.locateKey(p),
    value: (p) => parsed.locate(p)
  });
  return { ...cfg, ...base, ok: true };
}

function parseTomlConfig(path: string, text: string): ParsedWrangler {
  let root: Record<string, unknown>;
  try {
    root = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const line = err instanceof TomlError ? err.line : 1;
    const column = err instanceof TomlError ? err.column : 1;
    return {
      ...EMPTY,
      path,
      format: "toml",
      ok: false,
      errors: [
        {
          message:
            err instanceof Error ? firstLine(err.message) : "Invalid TOML",
          line,
          column
        }
      ]
    };
  }

  // smol-toml does not expose positions, so lines are found by searching for
  // the literal that identifies the entry. Best effort; absence yields no line.
  const lines = new LineIndex(text);
  const find = (needle: RegExp): Loc | undefined => {
    const m = needle.exec(text);
    if (!m) return undefined;
    const line = lines.at(m.index).line;
    return { line, endLine: line };
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cfg = normalise(root, {
    key: (p) => tomlLoc(p, root, find, esc),
    value: (p) => tomlLoc(p, root, find, esc)
  });
  return { ...cfg, path, format: "toml", ok: true, errors: [] };
}

function firstLine(s: string): string {
  return s.split("\n")[0];
}

function tomlLoc(
  path: (string | number)[],
  root: Record<string, unknown>,
  find: (re: RegExp) => Loc | undefined,
  esc: (s: string) => string
): Loc | undefined {
  const last = path[path.length - 1];
  if (typeof last === "string") {
    return find(new RegExp(`^\\s*${esc(last)}\\s*=`, "m"));
  }
  // Array element: point at the value's identifying string when it has one.
  let node: unknown = root;
  for (const seg of path) {
    node = (node as Record<string | number, unknown> | undefined)?.[seg];
  }
  const rec = asRecord(node);
  const id = rec && (asString(rec.class_name) ?? asString(rec.tag));
  if (id) return find(new RegExp(`"${esc(id)}"`));
  return undefined;
}

interface Locators {
  key(path: (string | number)[]): Loc | undefined;
  value(path: (string | number)[]): Loc | undefined;
}

function normalise(
  root: Record<string, unknown>,
  at: Locators
): Omit<ParsedWrangler, "path" | "format" | "ok" | "errors"> {
  const doBindings: DoBinding[] = [];
  const doList = asArray(asRecord(root.durable_objects)?.bindings);
  doList.forEach((raw, i) => {
    const b = asRecord(raw);
    const className = asString(b?.class_name);
    const name = asString(b?.name);
    if (!b || !className || !name) return;
    doBindings.push({
      name,
      className,
      scriptName: asString(b.script_name),
      loc: at.key(["durable_objects", "bindings", i, "class_name"])
    });
  });

  const migrations: Migration[] = [];
  asArray(root.migrations).forEach((raw, i) => {
    const m = asRecord(raw);
    if (!m) return;
    const classLocs: Record<string, Loc> = {};
    const locFor = (field: string, cls: string, idx: number) => {
      const loc = at.value(["migrations", i, field, idx]);
      if (loc) classLocs[cls] = loc;
    };
    const newClasses = asStringArray(m.new_classes);
    newClasses.forEach((c, j) => locFor("new_classes", c, j));
    const newSqlite = asStringArray(m.new_sqlite_classes);
    newSqlite.forEach((c, j) => locFor("new_sqlite_classes", c, j));
    const deleted = asStringArray(m.deleted_classes);
    deleted.forEach((c, j) => locFor("deleted_classes", c, j));
    const renamed = asArray(m.renamed_classes)
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => !!r)
      .map((r) => ({ from: asString(r.from) ?? "", to: asString(r.to) ?? "" }))
      .filter((r) => r.from && r.to);
    const transferredTo = asArray(m.transferred_classes)
      .map(asRecord)
      .map((r) => asString(r?.to))
      .filter((s): s is string => !!s);
    migrations.push({
      index: i,
      tag: asString(m.tag) ?? "",
      newClasses,
      newSqliteClasses: newSqlite,
      renamed,
      deleted,
      transferredTo,
      loc: at.key(["migrations", i, "tag"]),
      classLocs
    });
  });

  const workflows: WorkflowBinding[] = [];
  asArray(root.workflows).forEach((raw, i) => {
    const w = asRecord(raw);
    const className = asString(w?.class_name);
    const binding = asString(w?.binding);
    if (!w || !className || !binding) return;
    workflows.push({
      name: asString(w.name) ?? "",
      binding,
      className,
      scriptName: asString(w.script_name),
      loc: at.key(["workflows", i, "class_name"])
    });
  });

  const exportsList: ExportEntry[] = [];
  const exportsRec = asRecord(root.exports);
  if (exportsRec) {
    for (const [name, value] of Object.entries(exportsRec)) {
      const e = asRecord(value);
      if (!e) continue;
      exportsList.push({
        name,
        type: asString(e.type) ?? "",
        storage: asString(e.storage),
        state: asString(e.state),
        renamedTo: asString(e.renamed_to),
        loc: at.key(["exports", name])
      });
    }
  }

  const vars: VarEntry[] = [];
  const varsRec = asRecord(root.vars);
  if (varsRec) {
    for (const [key, value] of Object.entries(varsRec)) {
      vars.push({ key, value, loc: at.key(["vars", key]) });
    }
  }

  const envs: EnvSection[] = [];
  const envRec = asRecord(root.env);
  if (envRec) {
    for (const [name, value] of Object.entries(envRec)) {
      const section = asRecord(value);
      envs.push({
        name,
        keys: section ? Object.keys(section) : [],
        loc: at.key(["env", name])
      });
    }
  }

  const ai = asRecord(root.ai);
  const aiName = asString(ai?.binding);
  const flags = asStringArray(root.compatibility_flags);

  return {
    name: asString(root.name),
    main: asString(root.main),
    mainLoc: at.key(["main"]),
    compatibilityDate: asString(root.compatibility_date),
    compatibilityDateLoc: at.key(["compatibility_date"]),
    compatibilityFlags: flags,
    compatibilityFlagsLoc: at.key(["compatibility_flags"]),
    aiBinding: aiName ? { name: aiName, loc: at.key(["ai"]) } : undefined,
    doBindings,
    migrations,
    workflows,
    exports: exportsList,
    hasMigrationsKey: "migrations" in root,
    vars,
    varsLoc: at.key(["vars"]),
    envs,
    topLevelKeys: Object.keys(root),
    assetsDirectory: asString(asRecord(root.assets)?.directory)
  };
}

/**
 * Classes that exist after all migrations are applied in order, with whether
 * they use SQLite storage, plus classes deleted along the way.
 */
export function replayMigrations(migrations: readonly Migration[]): {
  live: Map<string, { sqlite: boolean; tag: string; index: number }>;
  deleted: Map<string, { tag: string; index: number }>;
} {
  const live = new Map<
    string,
    { sqlite: boolean; tag: string; index: number }
  >();
  const deleted = new Map<string, { tag: string; index: number }>();
  for (const m of migrations) {
    for (const c of m.newClasses) {
      live.set(c, { sqlite: false, tag: m.tag, index: m.index });
      deleted.delete(c);
    }
    for (const c of m.newSqliteClasses) {
      live.set(c, { sqlite: true, tag: m.tag, index: m.index });
      deleted.delete(c);
    }
    for (const r of m.renamed) {
      const prev = live.get(r.from);
      live.delete(r.from);
      live.set(r.to, {
        sqlite: prev?.sqlite ?? false,
        tag: m.tag,
        index: m.index
      });
    }
    for (const c of m.transferredTo) {
      live.set(c, { sqlite: false, tag: m.tag, index: m.index });
    }
    for (const c of m.deleted) {
      live.delete(c);
      deleted.set(c, { tag: m.tag, index: m.index });
    }
  }
  return { live, deleted };
}

export interface DoDeclaration {
  /** True when declared with SQLite storage. */
  sqlite: boolean;
  /** Where the declaration lives, for evidence. */
  loc?: Loc;
  source: "exports" | "migrations";
}

/**
 * Durable Object classes declared as live, from either the declarative
 * `exports` map or the legacy `migrations` array (a Worker uses only one).
 */
export function declaredDurableObjects(cfg: ParsedWrangler): {
  live: Map<string, DoDeclaration>;
  deleted: Map<string, { loc?: Loc; source: "exports" | "migrations" }>;
} {
  const live = new Map<string, DoDeclaration>();
  const deleted = new Map<
    string,
    { loc?: Loc; source: "exports" | "migrations" }
  >();

  for (const e of cfg.exports) {
    if (e.type !== "durable-object") continue;
    if (e.state === "deleted") {
      deleted.set(e.name, { loc: e.loc, source: "exports" });
    } else if (e.state === "renamed" || e.state === "transferred") {
      // The name no longer hosts a live namespace.
    } else {
      live.set(e.name, {
        sqlite: e.storage === "sqlite",
        loc: e.loc,
        source: "exports"
      });
    }
  }

  const replay = replayMigrations(cfg.migrations);
  for (const [name, info] of replay.live) {
    const m = cfg.migrations.find((x) => x.index === info.index);
    live.set(name, {
      sqlite: info.sqlite,
      loc: m?.classLocs[name] ?? m?.loc,
      source: "migrations"
    });
  }
  for (const [name, info] of replay.deleted) {
    const m = cfg.migrations.find((x) => x.index === info.index);
    deleted.set(name, {
      loc: m?.classLocs[name] ?? m?.loc,
      source: "migrations"
    });
  }
  return { live, deleted };
}
