export type SystemFont = { family: string; unitsPerEm: number; ascender: number; descender: number };

// Excalidraw stores fonts as numeric ids. Bundled fonts use 1–9 and fallbacks use 100 and 1000,
// so system fonts get a stable id derived from their name, well above that range.
export function fontId(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193);
  return 10_000 + ((hash >>> 0) % 1_000_000_000);
}

// Excalidraw joins family keys into CSS font strings without quoting them.
export function cssFamily(name: string): string {
  return `"${name.replace(/["\\]/g, "\\$&")}"`;
}

// Rounded to the steps Excalidraw uses for its bundled fonts' line heights.
export function lineHeight({ unitsPerEm, ascender, descender }: SystemFont): number {
  if (unitsPerEm <= 0) return 1.25;
  return Math.max(1, Math.round(((ascender - descender) / unitsPerEm) * 20) / 20);
}
