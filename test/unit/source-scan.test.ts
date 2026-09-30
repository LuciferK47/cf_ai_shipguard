import { describe, expect, it } from "vitest";
import {
  isAgentClass,
  scanSource,
  stripComments
} from "../../src/server/checks/source";

describe("stripComments", () => {
  it("blanks line and block comments but keeps line structure", () => {
    const src =
      "const a = 1; // env.AI\n/* export class Ghost {}\n */\nconst b = 2;";
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("env.AI");
    expect(out).not.toContain("Ghost");
    expect(out).toContain("const b = 2;");
    expect(out.length).toBe(src.length);
  });

  it("does not treat // inside strings as a comment", () => {
    const out = stripComments('const u = "https://example.com/a"; // tail');
    expect(out).toContain("https://example.com/a");
    expect(out).not.toContain("tail");
  });

  it("handles escaped quotes and template literals", () => {
    const out = stripComments(
      'const s = "a \\" // not a comment"; const t = `x // y`; // real'
    );
    expect(out).toContain("not a comment");
    expect(out).toContain("x // y");
    expect(out).not.toContain("real");
  });

  it("recovers from an unterminated quote at end of line", () => {
    const out = stripComments("const r = /'/; // c1\nconst k = 1; // c2");
    expect(out).toContain("const k = 1;");
    expect(out).not.toContain("c2");
  });
});

describe("scanSource: exports", () => {
  it("finds exported classes", () => {
    const s = scanSource(
      "a.ts",
      "export class A {}\nexport abstract class B {}\nclass C {}"
    );
    expect([...s.exportedNames].sort()).toEqual(["A", "B"]);
  });

  it("finds names in export lists, with aliases and re-exports", () => {
    const s = scanSource(
      "a.ts",
      'class X {}\nclass Y {}\nexport { X, Y as Renamed };\nexport { Z } from "./z";\nexport type { T };'
    );
    expect([...s.exportedNames].sort()).toEqual(["Renamed", "T", "X", "Z"]);
  });

  it("does not count default exports as named exports", () => {
    const s = scanSource(
      "a.ts",
      "export default class Foo {}\nexport { Bar as default };"
    );
    expect(s.exportedNames).toEqual([]);
  });

  it("ignores exports inside comments", () => {
    const s = scanSource(
      "a.ts",
      "// export class Ghost {}\n/* export { Phantom } */"
    );
    expect(s.exportedNames).toEqual([]);
  });

  it("detects star re-exports", () => {
    expect(scanSource("a.ts", 'export * from "./x";').hasStarExport).toBe(true);
    expect(scanSource("a.ts", 'export * as ns from "./x";').hasStarExport).toBe(
      false
    );
  });
});

describe("scanSource: classes and imports", () => {
  it("detects Agent subclasses only when the SDK is imported", () => {
    const withImport = scanSource(
      "a.ts",
      'import { AIChatAgent } from "@cloudflare/ai-chat";\nexport class Chat extends AIChatAgent<Env> {}'
    );
    expect(withImport.classes).toHaveLength(1);
    expect(isAgentClass(withImport.classes[0], withImport)).toBe(true);
    expect(withImport.classes[0].exported).toBe(true);

    const lookalike = scanSource("b.ts", "export class Chat extends Agent {}");
    expect(isAgentClass(lookalike.classes[0], lookalike)).toBe(false);
  });

  it("reports the line of a class declaration", () => {
    const s = scanSource(
      "a.ts",
      'import { Agent } from "agents";\n\nexport class Bot extends Agent {}'
    );
    expect(s.classes[0].line).toBe(3);
  });

  it("finds env.AI usage outside comments only", () => {
    expect(
      scanSource("a.ts", "// env.AI.run()\nconst x = 1;").envAiLine
    ).toBeUndefined();
    expect(
      scanSource("a.ts", "const x = 1;\nawait this.env.AI.run(m, {});")
        .envAiLine
    ).toBe(2);
    expect(scanSource("a.ts", 'env["AI"].run()').envAiLine).toBe(1);
    expect(scanSource("a.ts", "env.AIRPORT").envAiLine).toBeUndefined();
  });

  it("finds node: imports in all common forms", () => {
    const s = scanSource(
      "a.ts",
      'import a from "node:crypto";\nconst b = require("node:fs");\nconst c = await import("node:path");\nimport d from "crypto";'
    );
    expect(s.nodeImports.map((n) => n.spec)).toEqual([
      "node:crypto",
      "node:fs",
      "node:path"
    ]);
    expect(s.nodeImports.map((n) => n.line)).toEqual([1, 2, 3]);
  });

  it("detects @callable usage", () => {
    expect(scanSource("a.ts", "@callable()\nfoo() {}").usesCallable).toBe(true);
    expect(scanSource("a.ts", "// @callable()").usesCallable).toBe(false);
  });
});

import {
  mergeScans,
  planScanBatches,
  scanFiles
} from "../../src/server/checks/scan";

describe("scan batching (keeps each Workflow step under the Free-plan CPU cap)", () => {
  const files = new Map([
    ["a.ts", "x".repeat(40_000)],
    ["b.ts", "y".repeat(30_000)],
    ["c.ts", "z".repeat(5_000)],
    ["d.ts", "w".repeat(90_000)]
  ]);

  it("groups files without exceeding the batch size", () => {
    const batches = planScanBatches(files, 60_000);
    expect(batches).toEqual([["a.ts"], ["b.ts", "c.ts"], ["d.ts"]]);
  });

  it("gives an oversized file its own batch", () => {
    expect(
      planScanBatches(new Map([["big.ts", "x".repeat(500_000)]]), 60_000)
    ).toEqual([["big.ts"]]);
  });

  it("returns no batches for no files", () => {
    expect(planScanBatches(new Map())).toEqual([]);
  });

  it("covers every file exactly once", () => {
    const flat = planScanBatches(files, 50_000).flat();
    expect(flat.sort()).toEqual([...files.keys()].sort());
  });

  it("gives the same result whether scanned at once or in batches", () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const real = new Map([
      ["src/a.ts", 'export class A {}\nconst k = "' + key + '";'],
      [
        "src/b.ts",
        'import { Agent } from "agents";\nexport class B extends Agent {}'
      ],
      ["README.md", "text"]
    ]);
    const whole = scanFiles(real);
    const parts = mergeScans(
      planScanBatches(real, 10).map((paths) => scanFiles(real, paths))
    );
    expect(parts.sources.map((s) => s.path).sort()).toEqual(
      whole.sources.map((s) => s.path).sort()
    );
    expect(Object.keys(parts.secretHits)).toEqual(
      Object.keys(whole.secretHits)
    );
    expect(whole.sources.map((s) => s.path)).not.toContain("README.md");
    expect(whole.secretHits["src/a.ts"][0].line).toBe(2);
  });

  it("returns results without file text, so they fit in a step result", () => {
    const r = scanFiles(
      new Map([["a.ts", "export class A {}\n".repeat(1000)]])
    );
    expect(JSON.stringify(r).length).toBeLessThan(500);
  });
});
