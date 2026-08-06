import windows from '../../data/context-windows.json' with { type: 'json' };

const FALLBACK_WINDOW = 200_000;

// Numeric entries only — the JSON carries a `_note` metadata string we skip.
const TABLE: Array<[string, number]> = Object.entries(windows)
  .filter(([, v]) => typeof v === 'number')
  .map(([k, v]) => [k, v as number]);

/**
 * Resolve a model id to its max context window (the % full denominator).
 * Matches by exact id, then by longest matching prefix (dated ids like
 * `claude-haiku-4-5-20251001`). Returns `estimated:true` with the fallback
 * window for unknown or null models, so the caller can flag the % as a guess.
 */
export function windowFor(model: string | null): { window: number; estimated: boolean } {
  if (model) {
    const exact = TABLE.find(([k]) => k === model);
    if (exact) return { window: exact[1], estimated: false };
    const prefix = TABLE.filter(([k]) => model.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    if (prefix) return { window: prefix[1], estimated: false };
  }
  return { window: FALLBACK_WINDOW, estimated: true };
}
