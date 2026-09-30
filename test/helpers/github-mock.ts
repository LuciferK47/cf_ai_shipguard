import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A fake GitHub for the Workers-runtime tests. It runs in Node (as Miniflare's
// `outboundService`), so it can read the fixture repositories straight from disk.
//
// Repositories are addressed as https://github.com/test/<name>:
//   <name> is a fixture directory name, e.g. broken-do-migration
//   flipflop serves "broken-do-migration" at ref `broken` and "healthy-worker" at `main`
//   missing / private-repo answer 404, ratelimited answers 403 with an empty quota

// Kept free of imports from src/ so vitest.config.ts can load this file directly.
const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures");

const PLACEHOLDERS: Record<string, string> = {
  "{{AWS_KEY}}": ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "{{GITHUB_TOKEN}}": ["ghp", "_", "0123456789abcdefghij0123456789abcdef"].join(
    ""
  )
};

const VARIANTS: Record<string, Record<string, string>> = {
  flipflop: { main: "healthy-worker", broken: "broken-do-migration" },
  // These serve a repository with findings; the mock AI (mock-ai.mjs) keys its
  // behaviour off the repository name.
  "ai-quota": { main: "broken-do-migration" },
  "ai-garbage": { main: "broken-do-migration" },
  "ai-flaky": { main: "broken-do-migration" },
  "ai-hallucination": { main: "broken-do-migration" }
};

const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

interface Repo {
  files: Map<string, Buffer>;
  /** tree sha -> directory path within the repo ("" for the root) */
  trees: Map<string, string>;
}

const cache = new Map<string, Repo>();

function loadRepo(fixture: string, commit: string): Repo | undefined {
  const dir = join(FIXTURE_ROOT, fixture);
  if (!existsSync(dir)) return undefined;
  const key = `${fixture}@${commit}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const files = new Map<string, Buffer>();
  for (const full of walk(dir)) {
    const path = relative(dir, full).split(sep).join("/");
    if (path === "expected.json") continue;
    let text = readFileSync(full, "utf8");
    for (const [k, v] of Object.entries(PLACEHOLDERS))
      text = text.split(k).join(v);
    files.set(path, Buffer.from(text));
  }
  const trees = new Map<string, string>();
  trees.set(commit, ""); // a commit sha resolves to its root tree
  const dirs = new Set<string>([""]);
  for (const p of files.keys()) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of dirs) if (d !== "") trees.set(sha(`${key}:tree:${d}`), d);
  const repo = { files, trees };
  cache.set(key, repo);
  return repo;
}

export interface MockCall {
  method: string;
  url: string;
  authorization: boolean;
}

export function createGithubMock() {
  const calls: MockCall[] = [];

  function fixtureFor(name: string, ref: string): string | undefined {
    const variant = VARIANTS[name];
    if (variant) return variant[ref] ?? variant.main;
    return name;
  }

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.has("authorization")
    });

    if (url.hostname === "mock.local" && url.pathname === "/__calls")
      return json(calls);
    if (url.hostname === "mock.local" && url.pathname === "/__reset") {
      calls.length = 0;
      return json({ ok: true });
    }

    if (url.hostname === "api.github.com") {
      const m =
        /^\/repos\/([^/]+)\/([^/]+)(?:\/(commits|git\/trees)\/(.+))?$/.exec(
          url.pathname
        );
      if (!m) return new Response("{}", { status: 404 });
      const [, owner, name, kind, rest] = [...m];
      if (owner !== "test") return new Response("{}", { status: 404 });
      if (name === "missing" || name === "private-repo")
        return new Response("{}", { status: 404 });
      if (name === "ratelimited") {
        return new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1893456000"
          }
        });
      }
      if (name === "flaky-github") return new Response("{}", { status: 502 });

      if (!kind)
        return json({
          full_name: `test/${name}`,
          default_branch: "main",
          private: false,
          archived: false,
          size: 10
        });

      if (kind === "commits") {
        const ref = decodeURIComponent(rest);
        if (VARIANTS[name] && !VARIANTS[name][ref] && ref !== "main")
          return new Response("{}", { status: 422 });
        return new Response(sha(`${name}@${ref}`), {
          headers: { "content-type": "text/plain" }
        });
      }

      // git/trees/<sha>[?recursive=1]
      const treeSha = decodeURIComponent(rest);
      const refs = VARIANTS[name] ? Object.keys(VARIANTS[name]) : ["main"];
      for (const ref of refs) {
        const commit = sha(`${name}@${ref}`);
        const fixture = fixtureFor(name, ref);
        const repo = fixture ? loadRepo(fixture, commit) : undefined;
        const dirPath = repo?.trees.get(treeSha);
        if (!repo || dirPath === undefined) continue;
        const prefix = dirPath === "" ? "" : `${dirPath}/`;
        const recursive = url.searchParams.get("recursive") === "1";
        const entries: Array<{
          path: string;
          type: string;
          size?: number;
          sha: string;
        }> = [];
        const seenDirs = new Set<string>();
        for (const [p, body] of repo.files) {
          if (!p.startsWith(prefix)) continue;
          const local = p.slice(prefix.length);
          const parts = local.split("/");
          if (recursive) {
            entries.push({
              path: local,
              type: "blob",
              size: body.length,
              sha: sha(p)
            });
          } else if (parts.length === 1) {
            entries.push({
              path: local,
              type: "blob",
              size: body.length,
              sha: sha(p)
            });
          } else if (!seenDirs.has(parts[0])) {
            seenDirs.add(parts[0]);
            const childPath = `${prefix}${parts[0]}`;
            const childSha =
              [...repo.trees.entries()].find(([, d]) => d === childPath)?.[0] ??
              "";
            entries.push({ path: parts[0], type: "tree", sha: childSha });
          }
        }
        return json({ sha: treeSha, tree: entries, truncated: false });
      }
      return new Response("{}", { status: 404 });
    }

    if (url.hostname === "raw.githubusercontent.com") {
      const m = /^\/test\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const [, name, commit, path] = m;
      const refs = VARIANTS[name] ? Object.keys(VARIANTS[name]) : ["main"];
      for (const ref of refs) {
        if (sha(`${name}@${ref}`) !== commit) continue;
        const fixture = fixtureFor(name, ref);
        const repo = fixture ? loadRepo(fixture, commit) : undefined;
        const body = repo?.files.get(decodeURIComponent(path));
        if (body)
          return new Response(new Uint8Array(body), {
            headers: { "content-type": "text/plain" }
          });
      }
      return new Response("not found", { status: 404 });
    }

    // Everything else is refused, so a test can never reach the real network.
    return new Response(`blocked outbound request to ${url.hostname}`, {
      status: 502
    });
  };

  return { handler, calls };
}
