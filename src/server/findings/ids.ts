/** Per-target display ids: F-001, F-002, ... Numbers are never reused. */
export function displayId(n: number): string {
  return `F-${String(n).padStart(3, "0")}`;
}

const DISPLAY_ID = /^F-(\d{1,5})$/i;

export function parseDisplayId(text: string): string | undefined {
  const m = DISPLAY_ID.exec(text.trim());
  return m ? displayId(Number(m[1])) : undefined;
}

/** Every display id mentioned in free text, normalised and de-duplicated. */
export function findDisplayIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bF-(\d{1,5})\b/gi))
    seen.add(displayId(Number(m[1])));
  return [...seen];
}
