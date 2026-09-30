import type { TreeEntry } from "../github/client";
import { MAX_FILES_FETCHED, MAX_FILE_BYTES, MAX_TREE_ENTRIES } from "../limits";

// Turns a raw repository tree into a small, prioritised list of files worth
// fetching. Everything here is deterministic; no model is involved.

export interface FileToFetch {
  path: string;
  reason: string;
  score: number;
  size?: number;
}

export interface TreeInventory {
  /** Directory that is treated as the project root ("" for the repo root). */
  base: string;
  /** Other directories that also contain a Wrangler config (monorepos). */
  otherProjects: string[];
  /** True when ShipGuard picked the base itself rather than being told. */
  autoSelected: boolean;
  /** Number of files (blobs) under the base directory. */
  discovered: number;
  /** Number of fetchable source files under the base (before the fetch cap). */
  sourceFileCount: number;
  /** Highest-scoring source candidates, best first. */
  sourceCandidates: FileToFetch[];
  /** Configuration files to fetch first. */
  configFiles: FileToFetch[];
  /** Files skipped, counted by reason. */
  skipped: Record<string, number>;
  /** Files that exist but are never downloaded (secret-bearing). */
  neverFetched: string[];
  /** File paths under the base, for existence checks. May be incomplete. */
  paths: string[];
  pathsComplete: boolean;
  treeTruncated: boolean;
}

const MAX_PATH_INDEX = 3000;
const MAX_SOURCE_CANDIDATES = 60;

const WRANGLER_RE = /^wrangler\.(?:jsonc?|toml)$/;
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

const DEPENDENCY_DIRS = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  ".yarn",
  ".pnpm-store"
]);
const OUTPUT_DIRS = new Set([
  "dist",
  "build",
  "out",
  ".next",
  ".output",
  ".wrangler",
  "coverage",
  ".turbo",
  ".svelte-kit",
  ".nuxt",
  ".cache",
  ".vite"
]);
const TOOLING_DIRS = new Set([".git", ".idea", ".vscode", ".github"]);

const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|bin|exe|dll|so|dylib|class|pyc|sqlite|db)$/i;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "deno.lock"
]);

const SECRET_FILE = /^\.(?:env|dev\.vars)(?:\..+)?$/i;
const SECRET_EXAMPLE = /\.(?:example|sample|template|defaults?)$/i;

type SkipReason =
  | "dependency directory"
  | "build output"
  | "editor or tooling directory"
  | "lockfile"
  | "minified file or source map"
  | "binary or media file"
  | "generated declaration file"
  | `over ${number} KB`
  | "secret-bearing file (never fetched)";

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function segmentsOf(path: string): string[] {
  return path.split("/");
}

/** Why a file must not be fetched, or undefined if it may be. */
export function skipReason(
  path: string,
  size?: number
): SkipReason | undefined {
  const segs = segmentsOf(path);
  const name = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);

  if (dirs.some((d) => DEPENDENCY_DIRS.has(d))) return "dependency directory";
  if (dirs.some((d) => OUTPUT_DIRS.has(d))) return "build output";
  if (dirs.some((d) => TOOLING_DIRS.has(d)))
    return "editor or tooling directory";
  if (SECRET_FILE.test(name) && !SECRET_EXAMPLE.test(name)) {
    return "secret-bearing file (never fetched)";
  }
  if (LOCKFILES.has(name)) return "lockfile";
  if (/\.min\.(?:js|css|mjs)$/i.test(name) || /\.map$/i.test(name)) {
    return "minified file or source map";
  }
  if (BINARY_EXT.test(name)) return "binary or media file";
  if (/\.d\.[cm]?ts$/.test(name)) return "generated declaration file";
  if (size !== undefined && size > MAX_FILE_BYTES) {
    return `over ${Math.round(MAX_FILE_BYTES / 1000)} KB`;
  }
  return undefined;
}

/** Path relative to the base directory. */
function rel(path: string, base: string): string {
  return base === "" ? path : path.slice(base.length + 1);
}

function isUnder(path: string, base: string): boolean {
  return base === "" || path.startsWith(`${base}/`);
}

const MAX_CONFIG_DEPTH = 3;

/** Find directories that contain a Wrangler config, shallowest first. */
export function findProjectDirs(entries: readonly TreeEntry[]): string[] {
  const dirs = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const segs = segmentsOf(e.path);
    if (segs.length - 1 > MAX_CONFIG_DEPTH) continue;
    if (
      segs
        .slice(0, -1)
        .some((d) => DEPENDENCY_DIRS.has(d) || OUTPUT_DIRS.has(d))
    ) {
      continue;
    }
    if (WRANGLER_RE.test(segs[segs.length - 1])) dirs.add(dirName(e.path));
  }
  return [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)
  );
}

export function buildInventory(
  entries: readonly TreeEntry[],
  subpath: string,
  treeTruncated: boolean
): TreeInventory {
  const limited = entries.slice(0, MAX_TREE_ENTRIES);

  let base = subpath;
  let autoSelected = false;
  let otherProjects: string[] = [];
  if (subpath === "") {
    const projects = findProjectDirs(limited);
    if (projects.length > 0 && !projects.includes("")) {
      base = projects[0];
      autoSelected = true;
    }
    otherProjects = projects.filter((p) => p !== base);
  }

  const skipped: Record<string, number> = {};
  const neverFetched: string[] = [];
  const fetchable: TreeEntry[] = [];
  // Every file under the base is indexed, including skipped ones, because
  // existence checks (for example a Wrangler `main` inside dist/) care about
  // presence, not about whether ShipGuard would download the file.
  const paths: string[] = [];
  let discovered = 0;

  for (const e of limited) {
    if (e.type !== "blob" || !isUnder(e.path, base)) continue;
    discovered++;
    if (paths.length < MAX_PATH_INDEX) paths.push(e.path);
    const reason = skipReason(e.path, e.size);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      if (reason === "secret-bearing file (never fetched)") {
        neverFetched.push(e.path);
      }
      continue;
    }
    fetchable.push(e);
  }

  const configFiles: FileToFetch[] = [];
  const sources: FileToFetch[] = [];

  for (const e of fetchable) {
    const r = rel(e.path, base);
    const name = baseName(e.path);
    if (!r.includes("/")) {
      if (WRANGLER_RE.test(name)) {
        configFiles.push({
          path: e.path,
          reason: "Cloudflare deployment configuration",
          score: 100,
          size: e.size
        });
        continue;
      }
      if (name === "package.json") {
        configFiles.push({
          path: e.path,
          reason: "Package manifest and scripts",
          score: 90,
          size: e.size
        });
        continue;
      }
      if (name === "tsconfig.json") {
        configFiles.push({
          path: e.path,
          reason: "TypeScript configuration",
          score: 70,
          size: e.size
        });
        continue;
      }
      if (/^vite\.config\.[cm]?[jt]s$/.test(name)) {
        configFiles.push({
          path: e.path,
          reason: "Vite build configuration",
          score: 50,
          size: e.size
        });
        continue;
      }
    }
    if (CODE_EXT.test(name)) {
      sources.push({
        path: e.path,
        reason: sourceReason(r),
        score: scoreSource(r),
        size: e.size
      });
    }
  }

  configFiles.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  sources.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    base,
    otherProjects,
    autoSelected,
    discovered,
    sourceFileCount: sources.length,
    sourceCandidates: sources.slice(0, MAX_SOURCE_CANDIDATES),
    configFiles,
    skipped,
    neverFetched,
    paths,
    pathsComplete: discovered <= MAX_PATH_INDEX && !treeTruncated,
    treeTruncated
  };
}

const NAME_HINTS =
  /(?:^|\/)(?:index|server|worker|agent|agents|workflow|workflows|main|app)\.[cm]?[jt]sx?$/;
const PATH_HINTS = /(?:agent|workflow|durable|worker|server|handler|do)\b/i;
const TEST_HINTS =
  /(?:\.test\.|\.spec\.|__tests__|\/tests?\/|^tests?\/|fixtures?\/)/;
const CLIENT_HINTS =
  /(?:^|\/)(?:client|components?|ui|styles?|public|assets|stories)\//;

function scoreSource(relPath: string): number {
  const depth = relPath.split("/").length - 1;
  let score = 10;
  if (NAME_HINTS.test(relPath)) score += 60;
  if (PATH_HINTS.test(relPath)) score += 40;
  if (relPath.startsWith("src/")) score += 15;
  score += Math.max(0, 20 - depth * 4);
  if (TEST_HINTS.test(relPath)) score -= 45;
  if (CLIENT_HINTS.test(relPath)) score -= 25;
  if (/\.[cm]?jsx$|\.tsx$/.test(relPath)) score -= 10;
  return score;
}

function sourceReason(relPath: string): string {
  if (TEST_HINTS.test(relPath)) return "Test file";
  if (NAME_HINTS.test(relPath)) return "Likely Worker or Agent entry point";
  if (/workflow/i.test(relPath)) return "Workflow-related source";
  if (/agent/i.test(relPath)) return "Agent-related source";
  if (/durable|(?:^|\/)do\b/i.test(relPath))
    return "Durable Object-related source";
  return "Source file";
}

/**
 * Pick source files to fetch after the configuration has been read.
 * `mainPath` (the Wrangler `main` entry, repository-relative) always comes first.
 */
export function pickSources(
  inventory: TreeInventory,
  opts: { mainPath?: string; slots: number }
): FileToFetch[] {
  const slots = Math.max(0, Math.min(opts.slots, MAX_FILES_FETCHED));
  const picked: FileToFetch[] = [];
  const chosen = new Set<string>();

  if (opts.mainPath) {
    const main = inventory.sourceCandidates.find(
      (c) => c.path === opts.mainPath
    );
    if (main) {
      picked.push({
        ...main,
        reason: "Worker entry point (Wrangler main)",
        score: 1000
      });
      chosen.add(main.path);
    }
  }
  for (const c of inventory.sourceCandidates) {
    if (picked.length >= slots) break;
    if (chosen.has(c.path)) continue;
    picked.push(c);
    chosen.add(c.path);
  }
  return picked.slice(0, slots);
}

/** Repository-relative path of the Wrangler `main` file, or undefined. */
export function resolveMainPath(
  configPath: string,
  main: string | undefined
): string | undefined {
  if (!main) return undefined;
  const dir = dirName(configPath);
  const parts = [...(dir ? dir.split("/") : []), ...main.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return undefined; // escapes the repository
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}
