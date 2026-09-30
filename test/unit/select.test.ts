import { describe, expect, it } from "vitest";
import {
  buildInventory,
  findProjectDirs,
  pickSources,
  resolveMainPath,
  skipReason
} from "../../src/server/ingest/select";
import type { TreeEntry } from "../../src/server/github/client";
import { MAX_FILE_BYTES } from "../../src/server/limits";

const blob = (path: string, size = 500): TreeEntry => ({
  path,
  type: "blob",
  size
});

describe("skipReason", () => {
  it.each([
    ["node_modules/x/index.js", "dependency directory"],
    ["packages/a/node_modules/y.js", "dependency directory"],
    ["dist/index.js", "build output"],
    [".wrangler/state/x.js", "build output"],
    [".github/workflows/ci.yml", "editor or tooling directory"],
    ["package-lock.json", "lockfile"],
    ["pnpm-lock.yaml", "lockfile"],
    ["public/app.min.js", "minified file or source map"],
    ["src/a.js.map", "minified file or source map"],
    ["logo.png", "binary or media file"],
    ["fonts/a.woff2", "binary or media file"],
    ["worker-configuration.d.ts", "generated declaration file"],
    [".env", "secret-bearing file (never fetched)"],
    [".env.production", "secret-bearing file (never fetched)"],
    [".dev.vars", "secret-bearing file (never fetched)"],
    ["apps/web/.env.local", "secret-bearing file (never fetched)"]
  ])("skips %s", (path, reason) => {
    expect(skipReason(path)).toBe(reason);
  });

  it("allows example env files", () => {
    expect(skipReason(".env.example")).toBeUndefined();
    expect(skipReason(".dev.vars.example")).toBeUndefined();
  });

  it("skips files over the size limit but not at the limit", () => {
    expect(skipReason("src/big.ts", MAX_FILE_BYTES + 1)).toMatch(/^over /);
    expect(skipReason("src/ok.ts", MAX_FILE_BYTES)).toBeUndefined();
  });

  it("allows ordinary source and config", () => {
    expect(skipReason("src/index.ts")).toBeUndefined();
    expect(skipReason("wrangler.jsonc")).toBeUndefined();
  });
});

describe("findProjectDirs", () => {
  it("finds the root and nested Wrangler configs, shallowest first", () => {
    const dirs = findProjectDirs([
      blob("apps/api/wrangler.jsonc"),
      blob("wrangler.toml"),
      blob("apps/web/wrangler.json")
    ]);
    expect(dirs).toEqual(["", "apps/api", "apps/web"]);
  });

  it("ignores configs inside dependency or output directories", () => {
    expect(
      findProjectDirs([
        blob("node_modules/pkg/wrangler.toml"),
        blob("dist/wrangler.json")
      ])
    ).toEqual([]);
  });

  it("ignores configs nested too deep", () => {
    expect(findProjectDirs([blob("a/b/c/d/e/wrangler.toml")])).toEqual([]);
  });
});

describe("buildInventory", () => {
  it("uses the repository root when it holds the config", () => {
    const inv = buildInventory(
      [blob("wrangler.jsonc"), blob("package.json"), blob("src/index.ts")],
      "",
      false
    );
    expect(inv.base).toBe("");
    expect(inv.autoSelected).toBe(false);
    expect(inv.configFiles.map((f) => f.path)).toEqual([
      "wrangler.jsonc",
      "package.json"
    ]);
    expect(inv.discovered).toBe(3);
  });

  it("auto-selects a single nested project and lists the others", () => {
    const inv = buildInventory(
      [
        blob("README.md"),
        blob("apps/api/wrangler.jsonc"),
        blob("apps/api/package.json"),
        blob("apps/api/src/index.ts"),
        blob("apps/web/wrangler.jsonc")
      ],
      "",
      false
    );
    expect(inv.base).toBe("apps/api");
    expect(inv.autoSelected).toBe(true);
    expect(inv.otherProjects).toEqual(["apps/web"]);
    expect(inv.discovered).toBe(3);
  });

  it("respects an explicit subpath even when other projects exist", () => {
    const inv = buildInventory(
      [blob("a/wrangler.jsonc"), blob("b/wrangler.jsonc"), blob("b/src/x.ts")],
      "b",
      false
    );
    expect(inv.base).toBe("b");
    expect(inv.autoSelected).toBe(false);
    expect(inv.discovered).toBe(2);
  });

  it("counts skip reasons and lists secret files without fetching them", () => {
    const inv = buildInventory(
      [
        blob("wrangler.jsonc"),
        blob(".dev.vars"),
        blob(".env"),
        blob("package-lock.json"),
        blob("node_modules/a/b.js"),
        blob("logo.png")
      ],
      "",
      false
    );
    expect(inv.neverFetched.sort()).toEqual([".dev.vars", ".env"]);
    expect(inv.skipped["lockfile"]).toBe(1);
    expect(inv.skipped["dependency directory"]).toBe(1);
    expect(inv.skipped["binary or media file"]).toBe(1);
    expect(inv.configFiles.map((f) => f.path)).toEqual(["wrangler.jsonc"]);
  });

  it("keeps skipped paths in the existence index", () => {
    const inv = buildInventory(
      [blob("wrangler.jsonc"), blob("dist/index.js")],
      "",
      false
    );
    expect(inv.paths).toContain("dist/index.js");
    expect(inv.sourceCandidates.map((s) => s.path)).not.toContain(
      "dist/index.js"
    );
  });

  it("marks the path index incomplete when the tree was truncated", () => {
    const inv = buildInventory([blob("wrangler.jsonc")], "", true);
    expect(inv.pathsComplete).toBe(false);
    expect(inv.treeTruncated).toBe(true);
  });

  it("caps the index for very large repositories", () => {
    const many = Array.from({ length: 5000 }, (_, i) => blob(`src/f${i}.ts`));
    const inv = buildInventory([blob("wrangler.jsonc"), ...many], "", false);
    expect(inv.paths.length).toBe(3000);
    expect(inv.pathsComplete).toBe(false);
    expect(inv.discovered).toBe(5001);
    expect(inv.sourceCandidates.length).toBeLessThanOrEqual(60);
  });

  it("ignores directories and submodules", () => {
    const inv = buildInventory(
      [
        { path: "src", type: "tree" },
        { path: "vendor-sub", type: "commit" },
        blob("wrangler.jsonc")
      ],
      "",
      false
    );
    expect(inv.discovered).toBe(1);
  });
});

describe("source ranking", () => {
  const inv = buildInventory(
    [
      blob("wrangler.jsonc"),
      blob("src/server.ts"),
      blob("src/agent.ts"),
      blob("src/workflow.ts"),
      blob("src/utils/format.ts"),
      blob("src/components/Button.tsx"),
      blob("src/deep/a/b/c/thing.ts"),
      blob("test/server.test.ts")
    ],
    "",
    false
  );

  it("ranks entry points and Cloudflare-shaped files above helpers and UI", () => {
    const order = inv.sourceCandidates.map((s) => s.path);
    for (const top of ["src/server.ts", "src/agent.ts", "src/workflow.ts"]) {
      expect(order.indexOf(top)).toBeLessThan(
        order.indexOf("src/utils/format.ts")
      );
      expect(order.indexOf(top)).toBeLessThan(
        order.indexOf("src/components/Button.tsx")
      );
    }
  });

  it("ranks tests below entry points and plain helpers", () => {
    const order = inv.sourceCandidates.map((s) => s.path);
    const test = order.indexOf("test/server.test.ts");
    expect(test).toBeGreaterThan(order.indexOf("src/server.ts"));
    expect(test).toBeGreaterThan(order.indexOf("src/utils/format.ts"));
  });

  it("always puts the Wrangler main entry first", () => {
    const picked = pickSources(inv, {
      mainPath: "src/deep/a/b/c/thing.ts",
      slots: 3
    });
    expect(picked[0].path).toBe("src/deep/a/b/c/thing.ts");
    expect(picked[0].reason).toMatch(/Wrangler main/);
    expect(picked).toHaveLength(3);
  });

  it("respects the slot budget and never exceeds the per-audit fetch cap", () => {
    expect(pickSources(inv, { slots: 2 })).toHaveLength(2);
    expect(pickSources(inv, { slots: 0 })).toHaveLength(0);
    expect(pickSources(inv, { slots: 999 }).length).toBeLessThanOrEqual(20);
  });

  it("does not list the same file twice", () => {
    const picked = pickSources(inv, { mainPath: "src/server.ts", slots: 10 });
    expect(new Set(picked.map((p) => p.path)).size).toBe(picked.length);
  });

  it("ignores a main path that is not a fetchable source", () => {
    const picked = pickSources(inv, { mainPath: "dist/index.js", slots: 2 });
    expect(picked.map((p) => p.path)).not.toContain("dist/index.js");
  });
});

describe("resolveMainPath", () => {
  it("resolves relative to the config directory", () => {
    expect(resolveMainPath("wrangler.jsonc", "src/index.ts")).toBe(
      "src/index.ts"
    );
    expect(resolveMainPath("apps/api/wrangler.jsonc", "./src/index.ts")).toBe(
      "apps/api/src/index.ts"
    );
    expect(resolveMainPath("apps/api/wrangler.jsonc", "../shared/x.ts")).toBe(
      "apps/shared/x.ts"
    );
  });

  it("rejects paths that escape the repository", () => {
    expect(
      resolveMainPath("wrangler.jsonc", "../../etc/passwd")
    ).toBeUndefined();
  });

  it("returns undefined when main is absent", () => {
    expect(resolveMainPath("wrangler.jsonc", undefined)).toBeUndefined();
  });
});
