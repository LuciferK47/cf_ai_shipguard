import { isWranglerPath, parseWrangler } from "../config/wrangler";
import { MAX_FILES_FETCHED } from "../limits";
import {
  pickSources,
  resolveMainPath,
  type FileToFetch,
  type TreeInventory
} from "./select";

/**
 * Second phase of file selection: once the configuration has been fetched, use
 * the Wrangler `main` entry to decide which source files to fetch with the
 * remaining budget. Shared by the workflow and by the offline fixtures.
 */
export function chooseSources(
  inventory: TreeInventory,
  configTexts: ReadonlyMap<string, string>,
  alreadyFetched: number
): FileToFetch[] {
  let mainPath: string | undefined;
  for (const c of inventory.configFiles) {
    if (!isWranglerPath(c.path)) continue;
    const text = configTexts.get(c.path);
    if (text === undefined) continue;
    const cfg = parseWrangler(c.path, text);
    if (cfg.ok) {
      mainPath = resolveMainPath(cfg.path, cfg.main);
      break;
    }
  }
  return pickSources(inventory, {
    mainPath,
    slots: MAX_FILES_FETCHED - alreadyFetched
  });
}
