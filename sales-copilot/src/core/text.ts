// Text helpers: accent-insensitive matching tuned for spoken French.

export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`´]/g, "'")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9'€%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const cueCache = new Map<string, RegExp>();

/**
 * A cue matches at a word start. A trailing "*" is implicit: "essay" matches
 * "essaye", "essayé", "essayer". Use a trailing "$" to force a whole word ("non$").
 */
export function cueRegex(cue: string): RegExp {
  const cached = cueCache.get(cue);
  if (cached) return cached;
  const n = normalize(cue.replace(/\$$/, ""));
  const whole = cue.endsWith("$");
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(n)}${whole ? "(?![a-z0-9])" : ""}`);
  cueCache.set(cue, re);
  return re;
}

/** Returns the distinct cues found in an already-normalized text. */
export function matchCues(normalizedText: string, cues: string[]): string[] {
  const found: string[] = [];
  for (const cue of cues) {
    if (cue.trim() && cueRegex(cue).test(normalizedText)) found.push(cue);
  }
  return found;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Shortens a text for display as evidence, keeping whole words. */
export function excerpt(text: string, max = 160): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
