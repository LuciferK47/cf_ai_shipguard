import { describe, expect, it } from "vitest";
import {
  declaredDurableObjects,
  isWranglerPath,
  parseWrangler,
  replayMigrations
} from "../../src/server/config/wrangler";
import { parsePackage } from "../../src/server/config/package";
import { parseTsconfig } from "../../src/server/config/tsconfig";

describe("parseWrangler (JSONC)", () => {
  const text = `{
  // comments are allowed
  "name": "demo",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "durable_objects": { "bindings": [
    { "name": "A", "class_name": "ClassA" },
    { "name": "B", "class_name": "ClassB", "script_name": "other" }
  ] },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ClassA"], },
  ],
  "workflows": [{ "name": "w", "binding": "W", "class_name": "Flow" }],
  "vars": { "LEVEL": "info" },
  "env": { "staging": { "vars": {} } },
}`;
  const cfg = parseWrangler("wrangler.jsonc", text);

  it("parses despite comments and trailing commas", () => {
    expect(cfg.ok).toBe(true);
    expect(cfg.errors).toEqual([]);
    expect(cfg.name).toBe("demo");
    expect(cfg.main).toBe("src/index.ts");
    expect(cfg.compatibilityDate).toBe("2026-09-01");
    expect(cfg.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(cfg.aiBinding?.name).toBe("AI");
  });

  it("extracts bindings, migrations, workflows, vars and environments", () => {
    expect(
      cfg.doBindings.map((b) => [b.name, b.className, b.scriptName])
    ).toEqual([
      ["A", "ClassA", undefined],
      ["B", "ClassB", "other"]
    ]);
    expect(cfg.migrations[0].newSqliteClasses).toEqual(["ClassA"]);
    expect(cfg.workflows[0].className).toBe("Flow");
    expect(cfg.vars[0].key).toBe("LEVEL");
    expect(cfg.envs[0]).toMatchObject({ name: "staging", keys: ["vars"] });
    expect(cfg.hasMigrationsKey).toBe(true);
  });

  it("records 1-based line numbers", () => {
    expect(cfg.mainLoc?.line).toBe(4);
    expect(cfg.compatibilityDateLoc?.line).toBe(5);
    expect(cfg.doBindings[0].loc?.line).toBe(9);
    expect(cfg.migrations[0].classLocs.ClassA.line).toBe(13);
  });

  it("reports syntax errors with a position and marks the config unusable", () => {
    const bad = parseWrangler(
      "wrangler.jsonc",
      '{\n  "name": "x"\n  "main": "y"\n}'
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatchObject({ line: 3 });
    expect(bad.doBindings).toEqual([]);
  });

  it("rejects a non-object document", () => {
    const bad = parseWrangler("wrangler.json", "[1, 2]");
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/object/);
  });

  it("copes with empty or wrongly typed sections", () => {
    const odd = parseWrangler(
      "wrangler.json",
      '{"durable_objects": {"bindings": "nope"}, "migrations": [1, null], "vars": [], "env": 5}'
    );
    expect(odd.ok).toBe(true);
    expect(odd.doBindings).toEqual([]);
    expect(odd.migrations).toEqual([]);
    expect(odd.envs).toEqual([]);
  });
});

describe("parseWrangler (TOML)", () => {
  const toml = `name = "t"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[ai]
binding = "AI"

[[durable_objects.bindings]]
name = "A"
class_name = "ClassA"

[[migrations]]
tag = "v1"
new_classes = ["ClassA"]

[exports.ClassA]
type = "durable-object"
storage = "sqlite"
`;
  it("parses the same model", () => {
    const cfg = parseWrangler("wrangler.toml", toml);
    expect(cfg.ok).toBe(true);
    expect(cfg.format).toBe("toml");
    expect(cfg.aiBinding?.name).toBe("AI");
    expect(cfg.doBindings[0].className).toBe("ClassA");
    expect(cfg.migrations[0].newClasses).toEqual(["ClassA"]);
    expect(cfg.exports[0]).toMatchObject({ name: "ClassA", storage: "sqlite" });
  });

  it("finds best-effort lines", () => {
    const cfg = parseWrangler("wrangler.toml", toml);
    expect(cfg.mainLoc?.line).toBe(2);
    expect(cfg.doBindings[0].loc?.line).toBe(10);
  });

  it("reports TOML syntax errors with a line", () => {
    const bad = parseWrangler("wrangler.toml", 'name = "x"\nmain = = 1\n');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].line).toBe(2);
  });
});

describe("replayMigrations and declaredDurableObjects", () => {
  const mig = (
    over: Partial<Parameters<typeof replayMigrations>[0][number]>,
    i: number
  ) => ({
    index: i,
    tag: `v${i + 1}`,
    newClasses: [],
    newSqliteClasses: [],
    renamed: [],
    deleted: [],
    transferredTo: [],
    classLocs: {},
    ...over
  });

  it("applies create, rename and delete in order", () => {
    const { live, deleted } = replayMigrations([
      mig({ newSqliteClasses: ["A", "B"] }, 0),
      mig({ renamed: [{ from: "A", to: "A2" }] }, 1),
      mig({ deleted: ["B"] }, 2)
    ]);
    expect([...live.keys()]).toEqual(["A2"]);
    expect(live.get("A2")?.sqlite).toBe(true);
    expect(deleted.has("B")).toBe(true);
  });

  it("tracks the storage backend", () => {
    const { live } = replayMigrations([
      mig({ newClasses: ["K"], newSqliteClasses: ["S"] }, 0)
    ]);
    expect(live.get("K")?.sqlite).toBe(false);
    expect(live.get("S")?.sqlite).toBe(true);
  });

  it("un-deletes a class that is created again", () => {
    const { live, deleted } = replayMigrations([
      mig({ newSqliteClasses: ["A"] }, 0),
      mig({ deleted: ["A"] }, 1),
      mig({ newSqliteClasses: ["A"] }, 2)
    ]);
    expect(live.has("A")).toBe(true);
    expect(deleted.has("A")).toBe(false);
  });

  it("reads declarations from exports, including deleted state", () => {
    const cfg = parseWrangler(
      "wrangler.jsonc",
      `{"exports": {
        "A": {"type": "durable-object", "storage": "sqlite"},
        "B": {"type": "durable-object", "state": "deleted"},
        "W": {"type": "worker"}
      }}`
    );
    const { live, deleted } = declaredDurableObjects(cfg);
    expect([...live.keys()]).toEqual(["A"]);
    expect([...deleted.keys()]).toEqual(["B"]);
  });
});

describe("misc config helpers", () => {
  it("recognises Wrangler config paths", () => {
    expect(isWranglerPath("wrangler.jsonc")).toBe(true);
    expect(isWranglerPath("apps/api/wrangler.toml")).toBe(true);
    expect(isWranglerPath("wrangler.yaml")).toBe(false);
    expect(isWranglerPath("my-wrangler.json")).toBe(false);
  });

  it("parses package.json scripts with line numbers and merged deps", () => {
    const pkg = parsePackage(
      "package.json",
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  },\n  "dependencies": {"a": "1"},\n  "devDependencies": {"b": "2"}\n}'
    );
    expect(pkg.ok).toBe(true);
    expect(pkg.deps).toEqual({ a: "1", b: "2" });
    expect(pkg.scripts[0]).toMatchObject({ name: "deploy", loc: { line: 3 } });
  });

  it("tolerates a broken package.json", () => {
    expect(parsePackage("package.json", "{ nope").ok).toBe(false);
  });

  it("reads experimentalDecorators from a tsconfig with comments", () => {
    const ts = parseTsconfig(
      "tsconfig.json",
      '{\n  // hi\n  "compilerOptions": {\n    "experimentalDecorators": true,\n  }\n}'
    );
    expect(ts.experimentalDecorators).toBe(true);
    expect(ts.experimentalDecoratorsLoc?.line).toBe(4);
  });
});
