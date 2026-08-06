// The one definition of a token's WEIGHT. Two factors, and their provenance is not the same —
// which is why they are separate constants and why the UI states the difference:
//
//   Per token TYPE: Anthropic publishes these, expressed in tokens, as the Priority Tier
//   burndown rates — "Cache reads as 0.1 tokens per token read from the cache · Cache writes as
//   1.25 … with a 5 minute TTL · … 2.00 … with a 1 hour TTL · All other input tokens are 1 token
//   per token", and "These burndown rates reflect the relative pricing of each token type"
//   (platform.claude.com/docs/en/api/service-tiers, verified 2026-07-28).
//   We use 2.00 for cache writes because the cache lifetime is an hour on a subscription
//   (code.claude.com/docs/en/costs), which is what seedeep's users are on.
//
//   Per MODEL: NOT published. Six Anthropic pages were checked and the strongest official
//   statement is qualitative ("Opus costs several times more per turn than Sonnet, and Sonnet
//   more than Haiku"). Anthropic never converts models into a common token unit — it partitions
//   budgets (a separate Opus limit; Priority Tier commitments are per model version). So these
//   ratios are DERIVED FROM THE PRICE LIST and are seedeep's own; the surface says so.
//
// The result is a token count, never a cost in dollars: a heavier model simply counts for more.

/** Multiplier per kind of token — Anthropic's published burndown rates (1 h cache TTL). */
export const TOKEN_TYPE_WEIGHT = { input: 1, cacheWrite: 2.0, cacheRead: 0.1, output: 5 } as const;

/**
 * Per-model multiplier, keyed by model id, derived from the per-MTok input price list
 * (Haiku 4.5 = 1). Verified 2026-07-28; re-check when a model lands, and prefer
 * {@link modelWeight} over indexing this map so an unknown id degrades predictably.
 */
export const MODEL_WEIGHT: Readonly<Record<string, number>> = {
  'claude-haiku-4-5-20251001': 1,
  'claude-sonnet-5': 2,
  'claude-sonnet-4-6': 3,
  'claude-opus-4-5-20251101': 5,
  'claude-opus-4-6': 5,
  'claude-opus-4-7': 5,
  'claude-opus-4-8': 5,
  'claude-opus-5': 5,
  'claude-fable-5': 10,
};

/** Family multipliers, used only when an exact id is unknown — a new `claude-opus-*` must not
 * silently weigh the same as Haiku just because its version suffix moved. */
const FAMILY_WEIGHT: readonly [RegExp, number][] = [
  [/^claude-haiku/, 1],
  [/^claude-sonnet/, 3],
  [/^claude-opus/, 5],
  [/^claude-fable/, 10],
];

/**
 * The multiplier for a model id: exact match, else its family, else 0.
 * Zero is deliberate for an unrecognised id — including Claude Code's `<synthetic>` placeholder,
 * which is an api-error line carrying an all-zero usage block, not a call anyone paid for.
 * A model whose weight is unknown must not be given an invented one.
 */
export function modelWeight(model: string | null | undefined): number {
  if (!model) return 0;
  const exact = MODEL_WEIGHT[model];
  if (exact !== undefined) return exact;
  for (const [re, w] of FAMILY_WEIGHT) if (re.test(model)) return w;
  return 0;
}

/** The four token counts of ONE API call, as the reducer's usage delta reports them. */
export interface CallTokens {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/**
 * The weight of one API call: its tokens scaled by kind, then by the model that made it.
 * Callers must apply this ONCE per call — Claude Code repeats the same usage block on every
 * content-block line of a call, so summing per line multiplies the result.
 */
export function callWeight(model: string | null | undefined, t: CallTokens): number {
  const m = modelWeight(model);
  if (m === 0) return 0;
  return (
    m *
    (t.input * TOKEN_TYPE_WEIGHT.input +
      t.cacheCreation * TOKEN_TYPE_WEIGHT.cacheWrite +
      t.cacheRead * TOKEN_TYPE_WEIGHT.cacheRead +
      t.output * TOKEN_TYPE_WEIGHT.output)
  );
}
