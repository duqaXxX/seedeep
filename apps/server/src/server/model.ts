/**
 * Extract the model from a session's jsonl lines: the first assistant line with a
 * non-null `message.model`. Real sessions open with mode/system lines that carry
 * no model, so scan until one is found. Returns null if no line declares a model.
 * Pure — takes already-read lines, does no I/O.
 */
export function modelFromLines(lines: string[]): string | null {
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let d: any;
    try {
      d = JSON.parse(t);
    } catch {
      continue;
    }
    const m = d?.message?.model;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return null;
}
