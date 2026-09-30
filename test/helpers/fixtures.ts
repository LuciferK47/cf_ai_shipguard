import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildContext } from "../../src/server/checks/context";
import { scanFiles } from "../../src/server/checks/scan";
import type { CheckContext } from "../../src/server/checks/types";
import type { TreeEntry } from "../../src/server/github/client";
import { chooseSources } from "../../src/server/ingest/plan";
import {
  buildInventory,
  type TreeInventory
} from "../../src/server/ingest/select";

// Secret-shaped values are assembled at load time so that no token-like
// string is stored on disk (or trips a push-protection scanner).
const PLACEHOLDERS: Record<string, string> = {
  "{{AWS_KEY}}": ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "{{GITHUB_TOKEN}}": ["ghp", "_", "0123456789abcdefghij0123456789abcdef"].join(
    ""
  )
};

export const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures");

export interface FixtureExpectation {
  note: string;
  rules: string[];
  absent: string[];
}

export interface LoadedFixture {
  name: string;
  ctx: CheckContext;
  inventory: TreeInventory;
  expected: FixtureExpectation;
  /** Repository-relative paths that were "fetched" (read from disk). */
  fetched: string[];
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((n) => statSync(join(FIXTURE_ROOT, n)).isDirectory())
    .sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function substitute(text: string): string {
  let out = text;
  for (const [k, v] of Object.entries(PLACEHOLDERS)) out = out.split(k).join(v);
  return out;
}

/** Load a fixture exactly the way the workflow would ingest a repository. */
export function loadFixture(
  name: string,
  opts: { unread?: readonly string[] } = {}
): LoadedFixture {
  const dir = join(FIXTURE_ROOT, name);
  const entries: TreeEntry[] = walk(dir)
    .map((full) => ({ full, path: relative(dir, full).split(sep).join("/") }))
    .filter((f) => f.path !== "expected.json")
    .map((f) => ({
      path: f.path,
      type: "blob" as const,
      size: statSync(f.full).size
    }));

  const inventory = buildInventory(entries, "", false);
  const read = (path: string) =>
    substitute(readFileSync(join(dir, path), "utf8"));

  const unread: Record<string, string> = {};
  const files = new Map<string, string>();
  const fetchIfReadable = (path: string) => {
    if (opts.unread?.includes(path))
      unread[path] = "GitHub did not answer in time.";
    else files.set(path, read(path));
  };
  for (const c of inventory.configFiles) fetchIfReadable(c.path);
  for (const s of chooseSources(inventory, files, files.size))
    fetchIfReadable(s.path);

  const ctx = buildContext({
    base: inventory.base,
    files,
    paths: inventory.paths,
    pathsComplete: inventory.pathsComplete,
    neverFetched: inventory.neverFetched,
    otherProjects: inventory.otherProjects,
    sourceFileCount: inventory.sourceFileCount,
    unread,
    scan: scanFiles(files)
  });

  const expectedPath = join(dir, "expected.json");
  const expected: FixtureExpectation = existsSync(expectedPath)
    ? JSON.parse(readFileSync(expectedPath, "utf8"))
    : { note: "", rules: [], absent: [] };

  return { name, ctx, inventory, expected, fetched: [...files.keys()] };
}
