import type { Manifest, ManifestEntry, Target } from "../../shared/types";
import type { ShownFile } from "../ai/prompts";
import type { TreeInventory } from "../ingest/select";
import type { FetchedFile } from "./fetch";

/**
 * The evidence-selection record shown in the UI: what was found, what was read,
 * what the model saw, and what was skipped or never touched.
 */
export function buildManifest(input: {
  target: Target;
  ref: string;
  sha: string;
  inventory: TreeInventory;
  fetched: readonly FetchedFile[];
  shown: Readonly<Record<string, ShownFile>>;
}): Manifest {
  const { inventory, fetched, shown } = input;

  const selected: ManifestEntry[] = fetched.map((f) => ({
    path: f.path,
    reason: f.reason,
    chars: f.chars,
    fetched: f.text !== undefined,
    shownToAi: shown[f.path]?.mode ?? "no",
    error: f.error
  }));

  const skipped: Record<string, number> = { ...inventory.skipped };
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const notSelected = Math.max(
    0,
    inventory.discovered - skippedTotal - selected.length
  );
  if (notSelected > 0) skipped["not selected (lower priority)"] = notSelected;

  const name = `${input.target.owner}/${input.target.repo}`;
  return {
    repo: inventory.base ? `${name}/${inventory.base}` : name,
    ref: input.ref,
    sha: input.sha,
    filesDiscovered: inventory.discovered,
    filesSelected: selected.length,
    filesSkipped: Math.max(0, inventory.discovered - selected.length),
    treeTruncated: inventory.treeTruncated,
    selected,
    skipped,
    neverFetched: inventory.neverFetched
  };
}
