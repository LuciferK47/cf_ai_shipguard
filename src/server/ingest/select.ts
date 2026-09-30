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

// Directory checks are one anchored regex each rather than a split of every
// path: this runs for every file in the tree, and a Workflow step on the Free
// plan has only 10 ms of CPU.
const DEP_DIR_RE =
  /(?:^|\/)(?:node_modules|vendor|bower_components|\.yarn|\.pnpm-store)\//;
const OUT_DIR_RE =
  /(?:^|\/)(?:dist|build|out|\.next|\.output|\.wrangler|coverage|\.turbo|\.svelte-kit|\.nuxt|\.cache|\.vite)\//;
const TOOL_DIR_RE = /(?:^|\/)(?:\.git|\.idea|\.vscode|\.github)\//;

const BINARY_EXTS = new Set(
  "png jpg jpeg gif webp avif ico bmp svgz pdf zip gz tgz bz2 xz 7z rar jar wasm woff woff2 ttf otf eot mp3 mp4 mov avi webm ogg wav bin exe dll so dylib class pyc sqlite db".split(
    " "
  )
);
const MIN_RE = /\.min\.(?:js|css|mjs)$/i;

/** Why a file must not be fetched, or undefined if it may be. */
export function skipReason(
  path: string,
  size?: number
): SkipReason | undefined {
  // Only a path that contains a directory can match a directory rule.
  if (path.includes("/")) {
    if (DEP_DIR_RE.test(path)) return "dependency directory";
    if (OUT_DIR_RE.test(path)) return "build output";
    if (TOOL_DIR_RE.test(path)) return "editor or tooling directory";
  }

  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);

  if (
    name.charCodeAt(0) === 46 &&
    SECRET_FILE.test(name) &&
    !SECRET_EXAMPLE.test(name)
  ) {
    return "secret-bearing file (never fetched)";
  }
  if (LOCKFILES.has(name)) return "lockfile";
  if (name.endsWith(".map") || (name.includes(".min.") && MIN_RE.test(name))) {
    return "minified file or source map";
  }
  const dot = name.lastIndexOf(".");
  if (dot !== -1 && BINARY_EXTS.has(name.slice(dot + 1).toLowerCase())) {
    return "binary or media file";
  }
  if (
    name.endsWith(".d.ts") ||
    name.endsWith(".d.mts") ||
    name.endsWith(".d.cts")
  ) {
    return "generated declaration file";
  }
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
    const path = e.path;
    // Cheap test first: only a file named wrangler.* is of interest, and the
    // tree can hold thousands of entries.
    const slash = path.lastIndexOf("/");
    if (path.charCodeAt(slash + 1) !== 119 /* w */) continue;
    if (!WRANGLER_RE.test(path.slice(slash + 1))) continue;
    const dir = slash === -1 ? "" : path.slice(0, slash);
    if (dir !== "") {
      const segs = dir.split("/");
      if (segs.length > MAX_CONFIG_DEPTH) continue;
      if (segs.some((d) => DEPENDENCY_DIRS.has(d) || OUTPUT_DIRS.has(d)))
        continue;
    }
    dirs.add(dir);
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
      // The readable reason is filled in later, for the few files that are kept.
      sources.push({
        path: e.path,
        reason: "",
        score: scoreSource(r),
        size: e.size
      });
    }
  }

  configFiles.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  sources.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const kept = sources.slice(0, MAX_SOURCE_CANDIDATES);
  for (const c of kept) c.reason = sourceReason(rel(c.path, base));

  return {
    base,
    otherProjects,
    autoSelected,
    discovered,
    sourceFileCount: sources.length,
    sourceCandidates: kept,
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
// Applied to the lower-cased path, so no case-insensitive flag is needed.
const PATH_HINTS = /(?:agent|workflow|durable|worker|server|handler|do)\b/;
const TEST_HINTS =
  /(?:\.test\.|\.spec\.|__tests__|\/tests?\/|^tests?\/|fixtures?\/)/;
const CLIENT_HINTS =
  /(?:^|\/)(?:client|components?|ui|styles?|public|assets|stories)\//;

function countSlashes(s: string): number {
  let n = 0;
  for (let i = s.indexOf("/"); i !== -1; i = s.indexOf("/", i + 1)) n++;
  return n;
}

function scoreSource(relPath: string): number {
  const depth = countSlashes(relPath);
  let score = 10;
  if (NAME_HINTS.test(relPath)) score += 60;
  if (PATH_HINTS.test(relPath.toLowerCase())) score += 40;
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
