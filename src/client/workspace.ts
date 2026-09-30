// A workspace is one agent (one Durable Object), addressed by a random UUID.
// The browser generates it and keeps it; the server refuses any other name.
// There is no sign-in: knowing the id is what grants access, so it is treated
// like a private link and is never sent anywhere except to this app's own Worker.

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_KEY = "shipguard.workspace";

export function isWorkspaceId(
  value: string | null | undefined
): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Read `#w=<uuid>` from a URL hash. */
export function workspaceFromHash(hash: string): string | undefined {
  const m = /(?:^|[#&])w=([^&]+)/.exec(hash);
  return m && isWorkspaceId(m[1]) ? m[1].toLowerCase() : undefined;
}

export function workspaceHash(id: string): string {
  return `#w=${id}`;
}

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Pick the workspace for this page load: the one in the URL hash, else the one
 * remembered in this browser, else a new one. Storage can be unavailable
 * (private windows, blocked cookies), so every access is guarded.
 */
export function resolveWorkspace(
  hash: string,
  store: Store | undefined,
  generate: () => string = () => crypto.randomUUID()
): string {
  const fromHash = workspaceFromHash(hash);
  let remembered: string | undefined;
  try {
    const v = store?.getItem(STORAGE_KEY);
    if (isWorkspaceId(v)) remembered = v.toLowerCase();
  } catch {
    remembered = undefined;
  }
  const id = fromHash ?? remembered ?? generate().toLowerCase();
  try {
    store?.setItem(STORAGE_KEY, id);
  } catch {
    // Not persisted; the URL hash still carries it.
  }
  return id;
}
