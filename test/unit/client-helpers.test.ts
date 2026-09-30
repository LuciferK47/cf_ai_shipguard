import { describe, expect, it } from "vitest";
import {
  formatMs,
  githubBlobUrl,
  locationLabel,
  plural,
  projectName,
  relativeTime,
  safeHttpsUrl,
  shortSha
} from "../../src/client/format";
import {
  isWorkspaceId,
  resolveWorkspace,
  workspaceFromHash,
  workspaceHash
} from "../../src/client/workspace";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("workspace ids", () => {
  it("accepts UUIDs and rejects everything else", () => {
    expect(isWorkspaceId(ID)).toBe(true);
    expect(isWorkspaceId(ID.toUpperCase())).toBe(true);
    for (const bad of [
      "",
      "abc",
      "default",
      `${ID}x`,
      ID.slice(1),
      "../x",
      null,
      undefined
    ]) {
      expect(isWorkspaceId(bad as string)).toBe(false);
    }
  });

  it("reads the id from the URL hash", () => {
    expect(workspaceFromHash(`#w=${ID}`)).toBe(ID);
    expect(workspaceFromHash(`#foo=1&w=${ID}`)).toBe(ID);
    expect(workspaceFromHash("#w=not-a-uuid")).toBeUndefined();
    expect(workspaceFromHash("")).toBeUndefined();
    expect(workspaceHash(ID)).toBe(`#w=${ID}`);
  });

  it("prefers the URL, then the browser's memory, then makes a new one", () => {
    const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v)
    };

    expect(resolveWorkspace(`#w=${ID}`, store, () => other)).toBe(ID);
    expect([...mem.values()]).toEqual([ID]);
    expect(resolveWorkspace("", store, () => other)).toBe(ID); // remembered
    expect(
      resolveWorkspace(
        "",
        { getItem: () => null, setItem: () => undefined },
        () => other
      )
    ).toBe(other);
  });

  it("ignores a tampered stored value", () => {
    const store = { getItem: () => "../../admin", setItem: () => undefined };
    expect(resolveWorkspace("", store, () => ID)).toBe(ID);
  });

  it("still works when storage throws (private windows)", () => {
    const store = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };
    expect(resolveWorkspace("", store, () => ID)).toBe(ID);
    expect(resolveWorkspace("", undefined, () => ID)).toBe(ID);
  });
});

describe("formatting", () => {
  const t = { owner: "acme", repo: "worker" };

  it("builds GitHub links pinned to the audited commit", () => {
    const sha = "a".repeat(40);
    expect(
      githubBlobUrl(t, sha, {
        path: "wrangler.jsonc",
        lineStart: 6,
        lineEnd: 6
      })
    ).toBe(`https://github.com/acme/worker/blob/${sha}/wrangler.jsonc#L6`);
    expect(
      githubBlobUrl(t, sha, { path: "src/a b.ts", lineStart: 3, lineEnd: 9 })
    ).toBe(`https://github.com/acme/worker/blob/${sha}/src/a%20b.ts#L3-L9`);
    expect(githubBlobUrl(t, sha, { path: "x.ts" })).toBe(
      `https://github.com/acme/worker/blob/${sha}/x.ts`
    );
  });

  it("labels locations", () => {
    expect(locationLabel({ path: "a.ts", lineStart: 4 })).toBe("a.ts:4");
    expect(locationLabel({ path: "a.ts", lineStart: 4, lineEnd: 6 })).toBe(
      "a.ts:4-6"
    );
    expect(locationLabel({ path: "a.ts" })).toBe("a.ts");
  });

  it("only allows https links", () => {
    expect(safeHttpsUrl("https://developers.cloudflare.com/x")).toBe(
      "https://developers.cloudflare.com/x"
    );
    for (const bad of [
      "http://x.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "//x.com",
      "nope",
      "",
      undefined
    ]) {
      expect(safeHttpsUrl(bad)).toBeUndefined();
    }
  });

  it("formats times and durations", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(relativeTime("2026-09-30T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-30T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-09-30T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-28T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("garbage", now)).toBe("");
    expect(formatMs(undefined)).toBe("");
    expect(formatMs(0.2)).toBe("1 ms");
    expect(formatMs(840)).toBe("840 ms");
    expect(formatMs(2540)).toBe("2.5 s");
  });

  it("names things", () => {
    expect(shortSha("abcdef123456")).toBe("abcdef1");
    expect(projectName({ owner: "o", repo: "r", subpath: "" })).toBe("o/r");
    expect(projectName({ owner: "o", repo: "r", subpath: "apps/api" })).toBe(
      "o/r/apps/api"
    );
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(0, "match", "matches")).toBe("0 matches");
  });
});
