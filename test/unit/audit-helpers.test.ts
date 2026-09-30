import { describe, expect, it } from "vitest";
import {
  analysisCacheKey,
  readCachedAnalysis,
  sha256Hex,
  writeCachedAnalysis,
  type KvLike
} from "../../src/server/audit/cache";
import { decodeFailure, encodeFailure } from "../../src/server/audit/errors";
import { fetchFiles } from "../../src/server/audit/fetch";
import { buildManifest } from "../../src/server/audit/manifest";
import {
  derivePlan,
  deterministicSummary,
  mergeAndRank
} from "../../src/server/audit/plan";
import { GithubError, type GithubClient } from "../../src/server/github/client";
import { buildInventory } from "../../src/server/ingest/select";
import { MAX_FILE_BYTES, PROMPT_VERSION } from "../../src/server/limits";
import type { Finding } from "../../src/shared/types";

const SHA = "a".repeat(40);

function client(getRaw: GithubClient["getRaw"]): GithubClient {
  const nope = async () => {
    throw new Error("unexpected call");
  };
  return { getRepo: nope, getCommitSha: nope, getTree: nope, getRaw };
}

const pick = (path: string) => ({ path, reason: "test", score: 1 });

describe("fetchFiles", () => {
  it("returns text and sizes for fetched files", async () => {
    const c = client(async (_o, _r, _s, path) => ({
      text: `body of ${path}`,
      bytes: 10,
      truncated: false
    }));
    const { files, rateLimited } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("a.ts"), pick("b.ts")],
      1000
    );
    expect(rateLimited).toBeUndefined();
    expect(files.map((f) => [f.path, f.text, f.chars])).toEqual([
      ["a.ts", "body of a.ts", 12],
      ["b.ts", "body of b.ts", 12]
    ]);
  });

  it("records a failed file instead of throwing, so the step is not retried", async () => {
    const c = client(async (_o, _r, _s, path) => {
      if (path === "bad.ts")
        throw new GithubError("NOT_FOUND", "The file was not found.");
      return { text: "ok", bytes: 2, truncated: false };
    });
    const { files } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("good.ts"), pick("bad.ts")],
      1000
    );
    expect(files[0].text).toBe("ok");
    expect(files[1]).toMatchObject({
      path: "bad.ts",
      chars: 0,
      error: "The file was not found."
    });
    expect(files[1].text).toBeUndefined();
  });

  it("records timeouts and unexpected errors per file", async () => {
    const c = client(async (_o, _r, _s, path) => {
      if (path === "t.ts")
        throw new GithubError(
          "GITHUB_UNAVAILABLE",
          "GitHub did not answer in time.",
          { retryable: true }
        );
      throw new TypeError("boom");
    });
    const { files } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("t.ts"), pick("u.ts")],
      1000
    );
    expect(files[0].error).toBe("GitHub did not answer in time.");
    expect(files[1].error).toBe("unexpected error");
  });

  it("surfaces a rate limit so the audit can stop", async () => {
    const c = client(async () => {
      throw new GithubError("RATE_LIMITED", "limit", { resetAt: 5 });
    });
    const { files, rateLimited } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("a.ts")],
      1000
    );
    expect(rateLimited?.code).toBe("RATE_LIMITED");
    expect(files[0].error).toBe("GitHub rate limit reached");
  });

  it("skips binary and oversized files", async () => {
    const c = client(async (_o, _r, _s, path) =>
      path === "bin"
        ? { text: "ab\u0000cd", bytes: 5, truncated: false }
        : { text: "x".repeat(10), bytes: MAX_FILE_BYTES, truncated: true }
    );
    const { files } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("bin"), pick("big")],
      1000
    );
    expect(files[0].error).toBe("binary file");
    expect(files[1].error).toMatch(/size limit/);
  });

  it("enforces the total size budget in priority order", async () => {
    const c = client(async () => ({
      text: "x".repeat(600),
      bytes: 600,
      truncated: false
    }));
    const { files } = await fetchFiles(
      c,
      "o",
      "r",
      SHA,
      [pick("first"), pick("second"), pick("third")],
      1000
    );
    expect(files.map((f) => f.text !== undefined)).toEqual([
      true,
      false,
      false
    ]);
    expect(files[1].error).toBe("over the total size budget");
  });

  it("asks for the pinned commit and the per-file byte cap", async () => {
    const seen: unknown[][] = [];
    const c = client(async (...args) => {
      seen.push(args);
      return { text: "", bytes: 0, truncated: false };
    });
    await fetchFiles(c, "o", "r", SHA, [pick("a.ts")], 100);
    expect(seen[0]).toEqual(["o", "r", SHA, "a.ts", MAX_FILE_BYTES]);
  });

  it("handles no picks", async () => {
    const { files } = await fetchFiles(
      client(async () => ({ text: "", bytes: 0, truncated: false })),
      "o",
      "r",
      SHA,
      [],
      100
    );
    expect(files).toEqual([]);
  });
});

describe("failure encoding", () => {
  it("round-trips a code and message", () => {
    expect(
      decodeFailure(
        new Error(encodeFailure("NOT_FOUND", "The repository was not found."))
      )
    ).toEqual({
      code: "NOT_FOUND",
      message: "The repository was not found."
    });
  });

  it("decodes GithubError directly", () => {
    expect(decodeFailure(new GithubError("RATE_LIMITED", "slow down"))).toEqual(
      { code: "RATE_LIMITED", message: "slow down" }
    );
  });

  it("never exposes unexpected error text, only a generic message", () => {
    const d = decodeFailure(
      new Error(
        "TypeError: Cannot read properties of undefined at /src/secret/path.ts:99"
      )
    );
    expect(d.code).toBe("WORKFLOW_FAILED");
    expect(d.message).not.toContain("secret");
  });

  it("rejects an unknown code prefix", () => {
    expect(decodeFailure(new Error("[MADE_UP] hi")).code).toBe(
      "WORKFLOW_FAILED"
    );
  });

  it.each([undefined, null, 42, {}, ""])("handles %j", (v) => {
    expect(decodeFailure(v).code).toBe("WORKFLOW_FAILED");
  });
});

const f = (
  id: string,
  severity: Finding["severity"],
  source: Finding["source"] = "rule"
): Finding => ({
  fingerprint: id,
  ruleId: id,
  source,
  severity,
  confidence: 0.9,
  category: "c",
  title: `Title ${id}`,
  explanation: "e",
  recommendation: `Do ${id}`,
  evidence: []
});

describe("ranking and plan", () => {
  it("orders by severity, then by the model's priority, then original order", () => {
    const out = mergeAndRank(
      [f("a", "medium"), f("b", "high"), f("c", "high"), f("d", "low")],
      [f("e", "high", "ai")],
      [{ fingerprint: "c" }, { fingerprint: "e" }]
    );
    expect(out.map((x) => x.fingerprint)).toEqual(["c", "e", "b", "a", "d"]);
  });

  it("never lets priorities demote a critical finding", () => {
    const out = mergeAndRank(
      [f("low1", "low"), f("crit", "critical")],
      [],
      [{ fingerprint: "low1" }]
    );
    expect(out[0].fingerprint).toBe("crit");
  });

  it("removes duplicate fingerprints", () => {
    expect(
      mergeAndRank([f("a", "high")], [f("a", "high", "ai")], [])
    ).toHaveLength(1);
  });

  it("derives a plan from the most severe findings and skips info", () => {
    const plan = derivePlan([f("a", "high"), f("b", "info"), f("c", "medium")]);
    expect(plan).toEqual(["Title a: Do a", "Title c: Do c"]);
    expect(
      derivePlan(Array.from({ length: 20 }, (_, i) => f(`x${i}`, "high")))
    ).toHaveLength(5);
    expect(derivePlan([])).toEqual([]);
  });

  it("writes an honest deterministic summary", () => {
    expect(
      deterministicSummary([], {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0
      })
    ).toContain("No issues were found");
    expect(
      deterministicSummary([f("a", "high")], {
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        info: 0
      })
    ).toContain("deterministic rules");
  });
});

describe("manifest", () => {
  const inv = buildInventory(
    [
      "wrangler.jsonc",
      "package.json",
      "src/index.ts",
      "src/other.ts",
      "src/more.ts",
      "package-lock.json",
      ".dev.vars"
    ].map((path) => ({ path, type: "blob" as const, size: 10 })),
    "",
    false
  );

  it("describes what was selected, shown and skipped", () => {
    const m = buildManifest({
      target: { owner: "o", repo: "r", subpath: "" },
      ref: "main",
      sha: SHA,
      inventory: inv,
      fetched: [
        { path: "wrangler.jsonc", reason: "config", text: "{}", chars: 2 },
        { path: "src/index.ts", reason: "entry", text: "x", chars: 1 },
        {
          path: "src/other.ts",
          reason: "source",
          chars: 0,
          error: "binary file"
        }
      ],
      shown: {
        "wrangler.jsonc": { mode: "full", lineStart: 1, lineEnd: 1 },
        "src/index.ts": { mode: "partial", lineStart: 1, lineEnd: 1 }
      }
    });
    expect(m).toMatchObject({
      repo: "o/r",
      ref: "main",
      filesDiscovered: 7,
      filesSelected: 3,
      filesSkipped: 4,
      neverFetched: [".dev.vars"]
    });
    expect(m.selected.map((s) => [s.path, s.fetched, s.shownToAi])).toEqual([
      ["wrangler.jsonc", true, "full"],
      ["src/index.ts", true, "partial"],
      ["src/other.ts", false, "no"]
    ]);
    expect(m.selected[2].error).toBe("binary file");
    expect(m.skipped["lockfile"]).toBe(1);
    expect(m.skipped["secret-bearing file (never fetched)"]).toBe(1);
    expect(m.skipped["not selected (lower priority)"]).toBe(2);
  });

  it("names the sub-directory in the repo label", () => {
    const sub = buildInventory(
      [{ path: "apps/api/wrangler.jsonc", type: "blob", size: 1 }],
      "",
      false
    );
    const m = buildManifest({
      target: { owner: "o", repo: "r", subpath: "" },
      ref: "main",
      sha: SHA,
      inventory: sub,
      fetched: [],
      shown: {}
    });
    expect(m.repo).toBe("o/r/apps/api");
  });
});

describe("analysis cache", () => {
  const analysis = { summary: "s", priorities: [], plan: [], findings: [] };

  function fakeKv(): KvLike & { store: Map<string, string>; puts: number } {
    const store = new Map<string, string>();
    return {
      store,
      puts: 0,
      async get(k) {
        return store.get(k) ?? null;
      },
      async put(k, v) {
        this.puts++;
        store.set(k, v);
      }
    };
  }

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("changes the key when any input changes", async () => {
    const base = await analysisCacheKey("m", "sys", "user");
    expect(await analysisCacheKey("m", "sys", "user")).toBe(base);
    expect(await analysisCacheKey("m2", "sys", "user")).not.toBe(base);
    expect(await analysisCacheKey("m", "sys2", "user")).not.toBe(base);
    expect(await analysisCacheKey("m", "sys", "user2")).not.toBe(base);
    expect(base).toContain(`analysis:v${PROMPT_VERSION}:`);
  });

  it("round-trips a valid analysis", async () => {
    const kv = fakeKv();
    await writeCachedAnalysis(kv, "k", analysis);
    expect(await readCachedAnalysis(kv, "k")).toEqual(analysis);
    expect(kv.puts).toBe(1);
  });

  it("treats corrupt or schema-invalid entries as a miss", async () => {
    const kv = fakeKv();
    kv.store.set("bad-json", "{nope");
    kv.store.set("bad-shape", JSON.stringify({ summary: 1 }));
    expect(await readCachedAnalysis(kv, "bad-json")).toBeUndefined();
    expect(await readCachedAnalysis(kv, "bad-shape")).toBeUndefined();
    expect(await readCachedAnalysis(kv, "missing")).toBeUndefined();
  });

  it("never fails an audit because the cache is broken or absent", async () => {
    const broken: KvLike = {
      async get() {
        throw new Error("kv down");
      },
      async put() {
        throw new Error("kv down");
      }
    };
    expect(await readCachedAnalysis(broken, "k")).toBeUndefined();
    await expect(
      writeCachedAnalysis(broken, "k", analysis)
    ).resolves.toBeUndefined();
    expect(await readCachedAnalysis(undefined, "k")).toBeUndefined();
    await expect(
      writeCachedAnalysis(undefined, "k", analysis)
    ).resolves.toBeUndefined();
  });
});
