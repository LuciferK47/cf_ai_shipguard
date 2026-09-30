import { describe, expect, it } from "vitest";
import {
  createGithubClient,
  GithubError,
  looksBinary,
  readCapped
} from "../../src/server/github/client";
import { TREE_MAX_BYTES } from "../../src/server/limits";

const SHA = "a".repeat(40);

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
}

function fakeFetch(
  responder: (url: string) => Response | Promise<Response> | Error
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect
    });
    const r = await responder(url);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });

async function code(p: Promise<unknown>): Promise<GithubError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GithubError) return e;
    throw e;
  }
  throw new Error("expected GithubError");
}

describe("github client: happy paths", () => {
  it("getRepo returns the default branch", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        full_name: "o/r",
        default_branch: "main",
        private: false,
        size: 12
      })
    );
    const repo = await createGithubClient({ fetch }).getRepo("o", "r");
    expect(repo.defaultBranch).toBe("main");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r");
    expect(calls[0].redirect).toBe("manual");
  });

  it("getCommitSha asks for the sha media type", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(`${SHA}\n`));
    const sha = await createGithubClient({ fetch }).getCommitSha(
      "o",
      "r",
      "main"
    );
    expect(sha).toBe(SHA);
    expect(calls[0].headers.Accept).toBe("application/vnd.github.sha");
  });

  it("getCommitSha supports branch names containing slashes", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(SHA));
    await createGithubClient({ fetch }).getCommitSha("o", "r", "release/1.0");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/o/r/commits/release/1.0"
    );
  });

  it("getTree keeps only blobs, trees and commits and reports truncation", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        truncated: true,
        tree: [
          { path: "a.ts", type: "blob", size: 5 },
          { path: "src", type: "tree" },
          { path: "weird", type: "nonsense" }
        ]
      })
    );
    const tree = await createGithubClient({ fetch }).getTree("o", "r", SHA);
    expect(tree.entries.map((e) => e.path)).toEqual(["a.ts", "src"]);
    expect(tree.truncated).toBe(true);
  });

  it("getRaw builds a SHA-pinned raw URL with encoded segments", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("hello"));
    const file = await createGithubClient({ fetch }).getRaw(
      "o",
      "r",
      SHA,
      "src/my file.ts"
    );
    expect(file.text).toBe("hello");
    expect(calls[0].url).toBe(
      `https://raw.githubusercontent.com/o/r/${SHA}/src/my%20file.ts`
    );
  });
});

describe("github client: error taxonomy", () => {
  it.each([301, 302, 307, 308])(
    "never follows a %i redirect and explains it",
    async (status) => {
      const { fetch, calls } = fakeFetch(
        () =>
          new Response(null, {
            status,
            headers: { location: "https://evil.example/steal" }
          })
      );
      const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
      expect(e.code).toBe("NOT_FOUND");
      expect(e.message).toMatch(/renamed or moved/);
      expect(calls).toHaveLength(1);
      expect(calls[0].redirect).toBe("manual");
    }
  );

  it("maps 404 to NOT_FOUND and mentions private repositories", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 404 }));
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/private/i);
  });

  it("rejects a repository GitHub reports as private", async () => {
    const { fetch } = fakeFetch(() =>
      json({ full_name: "o/r", default_branch: "main", private: true })
    );
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.code).toBe("NOT_FOUND");
  });

  it("maps 403 with an exhausted quota to RATE_LIMITED with the reset time", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1893456000"
          }
        })
    );
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.resetAt).toBe(1893456000);
    expect(e.message).toContain("2030-01-01");
    expect(e.message).toContain("GITHUB_TOKEN");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 429 }));
    const e = await code(createGithubClient({ fetch }).getTree("o", "r", SHA));
    expect(e.code).toBe("RATE_LIMITED");
  });

  it("does not suggest a token when one is already configured", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 429 }));
    const e = await code(
      createGithubClient({ fetch, token: "t" }).getTree("o", "r", SHA)
    );
    expect(e.message).not.toContain("GITHUB_TOKEN");
  });

  it("marks 5xx as retryable", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 502 }));
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.code).toBe("GITHUB_UNAVAILABLE");
    expect(e.retryable).toBe(true);
  });

  it("marks network failures as retryable", async () => {
    const { fetch } = fakeFetch(() => new TypeError("network down"));
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.code).toBe("GITHUB_UNAVAILABLE");
    expect(e.retryable).toBe(true);
  });

  it("marks timeouts as retryable", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const { fetch } = fakeFetch(() => timeout);
    const e = await code(createGithubClient({ fetch }).getRepo("o", "r"));
    expect(e.message).toMatch(/in time/);
    expect(e.retryable).toBe(true);
  });

  it("maps 401 to a non-retryable token error that never echoes the token", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 401 }));
    const e = await code(
      createGithubClient({ fetch, token: "ghp_SECRETSECRETSECRET" }).getRepo(
        "o",
        "r"
      )
    );
    expect(e.retryable).toBe(false);
    expect(e.message).not.toContain("SECRET");
  });

  it("maps 422 to a missing ref", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 422 }));
    const e = await code(
      createGithubClient({ fetch }).getCommitSha("o", "r", "nope")
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/branch, tag or commit/);
  });
});

describe("github client: input hardening", () => {
  const client = () =>
    createGithubClient({ fetch: fakeFetch(() => new Response("x")).fetch });

  it("refuses a non-SHA when fetching raw files", async () => {
    const e = await code(client().getRaw("o", "r", "main", "a.ts"));
    expect(e.code).toBe("INVALID_URL");
  });

  it("refuses traversal segments in a file path", async () => {
    const e = await code(
      client().getRaw("o", "r", SHA, "src/../../etc/passwd")
    );
    expect(e.code).toBe("INVALID_URL");
  });

  it("refuses odd owner and repo values", async () => {
    expect((await code(client().getRepo("o/../x", "r"))).code).toBe(
      "INVALID_URL"
    );
    expect((await code(client().getRepo("o", "r?x=1"))).code).toBe(
      "INVALID_URL"
    );
  });

  it("refuses refs with traversal", async () => {
    const e = await code(client().getCommitSha("o", "r", "a/../b"));
    expect(e.code).toBe("INVALID_URL");
  });
});

describe("github client: token handling", () => {
  it("sends the token to the API but never to the raw host", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith("https://raw.")
        ? new Response("body")
        : json({ full_name: "o/r", default_branch: "main" })
    );
    const client = createGithubClient({ fetch, token: "tok123" });
    await client.getRepo("o", "r");
    await client.getRaw("o", "r", SHA, "a.ts");
    expect(calls[0].headers.Authorization).toBe("Bearer tok123");
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls[1])).not.toContain("tok123");
  });

  it("works without a token", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ full_name: "o/r", default_branch: "main" })
    );
    await createGithubClient({ fetch }).getRepo("o", "r");
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("readCapped", () => {
  it("returns small bodies untouched", async () => {
    const r = await readCapped(new Response("abc"), 100);
    expect(r).toEqual({ text: "abc", bytes: 3, truncated: false });
  });

  it("truncates at the byte limit and reports it", async () => {
    const r = await readCapped(new Response("x".repeat(500)), 100);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(100);
    expect(r.text).toHaveLength(100);
  });

  it("does not read past the limit from a stream", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("y".repeat(64)));
        if (pulled > 1000) controller.close();
      }
    });
    const r = await readCapped(new Response(stream), 128);
    expect(r.truncated).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("handles an empty body", async () => {
    const r = await readCapped(new Response(null), 10);
    expect(r.bytes).toBe(0);
  });
});

describe("looksBinary", () => {
  it("flags NUL bytes", () => {
    expect(looksBinary("ab\u0000cd")).toBe(true);
    expect(looksBinary("plain text")).toBe(false);
  });
});

describe("github client: sub-directory trees", () => {
  const T1 = "1".repeat(40);
  const T2 = "2".repeat(40);
  const T3 = "3".repeat(40);

  function treeFetch(map: Record<string, unknown>) {
    return fakeFetch((url) => {
      const key = Object.keys(map).find((k) => url.includes(k));
      return key ? json(map[key]) : new Response("{}", { status: 404 });
    });
  }

  it("descends one level at a time and only downloads the subtree recursively", async () => {
    const { fetch, calls } = treeFetch({
      [`/git/trees/${SHA}`]: {
        tree: [
          { path: "apps", type: "tree", sha: T1 },
          { path: "big", type: "tree", sha: "9".repeat(40) }
        ]
      },
      [`/git/trees/${T1}`]: { tree: [{ path: "api", type: "tree", sha: T2 }] },
      [`/git/trees/${T2}?recursive=1`]: {
        tree: [
          { path: "wrangler.jsonc", type: "blob", size: 10 },
          { path: "src/index.ts", type: "blob", size: 20 }
        ]
      }
    });
    const r = await createGithubClient({ fetch }).getTree(
      "o",
      "r",
      SHA,
      "apps/api"
    );
    expect(r.entries.map((e) => e.path)).toEqual([
      "apps/api/wrangler.jsonc",
      "apps/api/src/index.ts"
    ]);
    expect(r.apiCalls).toBe(3);
    expect(
      calls.map((c) => c.url.replace("https://api.github.com/repos/o/r", ""))
    ).toEqual([
      `/git/trees/${SHA}`,
      `/git/trees/${T1}`,
      `/git/trees/${T2}?recursive=1`
    ]);
  });

  it("uses a single recursive call for the repository root", async () => {
    const { fetch, calls } = treeFetch({
      "recursive=1": { tree: [{ path: "a.ts", type: "blob" }] }
    });
    const r = await createGithubClient({ fetch }).getTree("o", "r", SHA);
    expect(r.apiCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.entries[0].path).toBe("a.ts");
  });

  it("reports a missing directory clearly", async () => {
    const { fetch } = treeFetch({
      [`/git/trees/${SHA}`]: { tree: [{ path: "src", type: "tree", sha: T1 }] }
    });
    const e = await code(
      createGithubClient({ fetch }).getTree("o", "r", SHA, "nope")
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("`nope`");
  });

  it("does not follow a file with the directory's name", async () => {
    const { fetch } = treeFetch({
      [`/git/trees/${SHA}`]: { tree: [{ path: "docs", type: "blob", sha: T3 }] }
    });
    const e = await code(
      createGithubClient({ fetch }).getTree("o", "r", SHA, "docs")
    );
    expect(e.code).toBe("NOT_FOUND");
  });

  it("refuses a tree larger than the byte cap and suggests a sub-directory", async () => {
    const huge = JSON.stringify({
      tree: Array.from({ length: 9000 }, (_, i) => ({
        path: `src/file-number-${i}.ts`,
        type: "blob",
        sha: T3,
        url: `https://api.github.com/repos/o/r/git/blobs/${T3}`
      }))
    });
    expect(huge.length).toBeGreaterThan(TREE_MAX_BYTES);
    const { fetch } = fakeFetch(() => new Response(huge));
    const e = await code(createGithubClient({ fetch }).getTree("o", "r", SHA));
    expect(e.code).toBe("REPO_TOO_LARGE");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/sub-directory/);
  });

  it("does not read an oversized tree body past the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(100_000)));
      }
    });
    const { fetch } = fakeFetch(() => new Response(stream));
    await code(createGithubClient({ fetch }).getTree("o", "r", SHA));
    expect(pulled).toBeLessThan(30);
  });

  it("treats an unreadable tree body as a retryable GitHub problem", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>"));
    const e = await code(createGithubClient({ fetch }).getTree("o", "r", SHA));
    expect(e.code).toBe("GITHUB_UNAVAILABLE");
    expect(e.retryable).toBe(true);
  });

  it("passes through GitHub's own truncation flag", async () => {
    const { fetch } = fakeFetch(() =>
      json({ truncated: true, tree: [{ path: "a", type: "blob" }] })
    );
    expect(
      (await createGithubClient({ fetch }).getTree("o", "r", SHA)).truncated
    ).toBe(true);
  });

  it("rejects hostile path segments before any request", async () => {
    const { fetch, calls } = fakeFetch(() => json({ tree: [] }));
    const e = await code(
      createGithubClient({ fetch }).getTree("o", "r", SHA, "a/../b")
    );
    expect(e.code).toBe("INVALID_URL");
    expect(calls).toHaveLength(0);
  });
});
