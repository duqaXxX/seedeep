import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributedTokens,
  buildShareCardHtml,
  CARD_DPR,
  CARD_H,
  CARD_W,
  type ShareCardData,
  shareCardSvg,
} from '../src/core/share-card.ts';

// The PNG is not assertable; the HTML that produces it is. These cover the two things that
// were actually wrong on the rendered card: a nonsense total, and a label printed twice.

const base: ShareCardData = {
  turnIndex: 47,
  turnOrdinal: 31,
  totalTurns: 42,
  durationMs: 384_000,
  date: '2026-07-25',
  severity: 'crit',
  mult: '3.4',
  billable: 187_400,
  p50: 55_100,
  p90: 118_000,
  p95: 142_000,
  findings: [
    {
      kind: 'resume',
      severity: 'warn',
      text: 'resumed cold — 143.9k tokens re-created before any work',
      cost: '77% of the turn',
    },
    {
      kind: 'compaction',
      severity: 'crit',
      text: 'compaction mid-turn — cache rebuilt, +28.1k on the next turn',
      cost: '48.2k',
    },
    { kind: 'unverified-ship', severity: 'crit', text: 'committed code with no check run anywhere in this session' },
  ],
  stats: { apiCalls: 34, toolCalls: 61, subagents: 3, cacheRead: 4_120_000, model: 'claude-opus-5', effort: 'high' },
};

test('attributed tokens sum only absolute costs — a multiplier is not a token count', () => {
  // A relative cost used to be parsed as a token count and silently added to the total. The
  // producible one today is the resume's "77% of the turn" (in `base.findings` above); the "3.4×"
  // form has no producer since the anomaly went, and is kept because the parser must not start
  // accepting it if one returns.
  assert.equal(attributedTokens(base.findings), 48_200);
  assert.equal(attributedTokens([{ kind: 'resume', severity: 'warn', text: 'x', cost: '3.4×' }]), 0);
  assert.equal(attributedTokens([{ kind: 'esc', severity: 'warn', text: 'x', cost: '~1.5M' }]), 1_500_000);
  assert.equal(attributedTokens([{ kind: 'context', severity: 'warn', text: 'no cost at all' }]), 0);
  assert.equal(
    attributedTokens([{ kind: 'resume', severity: 'warn', text: 'x', cost: '77% of the turn' }]),
    0,
    'a share is not a token count',
  );
});

test('the attributed-tokens line names itself once', () => {
  // The old card printed "estimated waste ~48.2k estimated waste · 26%": the label was in the
  // template AND inside the value.
  const html = buildShareCardHtml(base);
  assert.equal(html.match(/tokens attributed to findings/g)?.length, 1);
  assert.match(html, /~48\.2k/);
  assert.match(html, /26% of the turn/);
});

test('the card states what the turn DID, not only its verdict', () => {
  const html = buildShareCardHtml(base);
  for (const label of ['api calls', 'tool calls', 'subagents', 'cache reads', 'model', 'duration'])
    assert.ok(html.includes(label), 'missing stat: ' + label);
  assert.match(html, />34</, 'api calls');
  assert.match(html, />61</, 'tool calls');
  assert.match(html, /opus 5 · high/, 'model and effort, shortened');
  assert.match(html, /6m24s/, 'duration');
  // The hero is the token count — true with or without a baseline. "3.4×" alone never said
  // 3.4× of what.
  assert.match(html, /class="hero">187\.4k/);
  assert.match(html, /3\.4× your median turn \(55\.1k\)/);
});

test('the scale bar is drawn only when the baseline really has the percentiles', () => {
  assert.match(buildShareCardHtml(base), /p95<\/div>/);
  const noBaseline = buildShareCardHtml({ ...base, mult: null, p50: null, p90: null, p95: null });
  assert.doesNotMatch(noBaseline, /p95<\/div>/, 'no invented ticks');
  assert.match(noBaseline, /no personal baseline yet/);
  assert.match(noBaseline, /class="hero">187\.4k/, 'the hero still holds');
});

test('a clean turn says what was checked, not just "nothing"', () => {
  const html = buildShareCardHtml({ ...base, severity: 'good', findings: [] });
  assert.match(html, /CLEAN/);
  assert.match(html, /No waste pattern detected/);
  assert.doesNotMatch(html, /tokens attributed to findings/, 'no total when there is nothing to total');
});

test('finding text is escaped — it can carry a file name with angle brackets', () => {
  const html = buildShareCardHtml({
    ...base,
    findings: [{ kind: 'context', severity: 'warn', text: '<script>x</script>' }],
  });
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&lt;script&gt;/);
});

test('a finding never attributes more tokens to a turn than the turn spent', () => {
  // Measured before the fix: 247 of 457 real flagged turns (54%) printed "> 100% of the turn",
  // p90 8571%, max 122097%. Two causes, both fixed at the source in verdict.ts — the `context`
  // finding put the window's SIZE in `cost`, and `compaction` put a cross-turn total there.
  // This asserts the invariant the card depends on, so a future finding cannot reintroduce it.
  const turn = { billable: 60_000 };
  const contextFinding = {
    kind: 'context',
    severity: 'warn' as const,
    text: 'context 81% full at the end of the turn (162.5k)',
  };
  const compactionFinding = {
    kind: 'compaction',
    severity: 'crit' as const,
    text: 'compaction mid-turn — cache rebuilt, +28.1k on the next turn',
    cost: '49.6k',
  };
  const attributed = attributedTokens([contextFinding, compactionFinding]);
  assert.equal(attributed, 49_600, 'only the tokens THIS turn paid');
  assert.ok(attributed <= turn.billable, `${attributed} must not exceed the turn's ${turn.billable}`);
});

// ─── legibility ────────────────────────────────────────────────────────────────
// The card is READ at a fraction of its 1200px frame — in the preview box, in a timeline, on a
// screen that resamples it. Two things made its text soft: it was rendered one image pixel per
// CSS pixel, and its smallest labels were also its lowest-contrast ones (#61748f on #05070c is
// 4.2:1, under the 4.5:1 floor). Both are asserted here because both regress silently.

test('no text on the card is smaller than 12px', () => {
  const html = buildShareCardHtml(base);
  const sizes = [...html.matchAll(/font:(?:\s*\d+\s+)?(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10, 'the card really does set its type in the markup');
  const tiny = sizes.filter((s) => s < 12);
  assert.deepEqual(tiny, [], 'these font sizes are below the floor: ' + tiny.join(', '));
});

test('the card does not print text in the colour that failed contrast', () => {
  const html = buildShareCardHtml(base);
  assert.equal(/color:#61748f/.test(html), false, '#61748f is 4.2:1 on the card background');
});

// The PNG is now drawn by the page itself, so these two facts have no browser to be checked in —
// and both of them have already been wrong once. The DPR was 1 and every surface that resampled the
// card softened its text; the SVG was loaded from a `blob:` URL and Chrome TAINTED the canvas, so
// `toBlob` threw and no image came out at all. A stub DOM is enough to hold both.
test('the card is drawn at two pixels per CSS pixel, from a data: URL', async () => {
  const { renderShareCardPng } = await import('../src/client/share-card-png.ts');
  const canvas: any = {
    width: 0,
    height: 0,
    getContext: () => ({ scale() {}, drawImage() {} }),
    toBlob: (cb: (b: unknown) => void) => cb({ type: 'image/png' }),
  };
  let loadedFrom = '';
  const g = globalThis as any;
  g.document = { createElement: (tag: string) => (tag === 'canvas' ? canvas : {}) };
  g.Image = class {
    set src(v: string) {
      loadedFrom = v;
    }
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      // A real Image loads asynchronously; firing on the microtask queue keeps the awaited
      // promise in `renderShareCardPng` from being resolved before it is even created.
      queueMicrotask(() => this.onload?.());
    }
  };
  try {
    const blob = (await renderShareCardPng(base)) as any;
    assert.equal(blob.type, 'image/png');
    assert.equal(canvas.width, CARD_W * CARD_DPR);
    assert.equal(canvas.height, CARD_H * CARD_DPR);
    assert.ok(loadedFrom.startsWith('data:image/svg+xml'), `a blob: URL taints the canvas: ${loadedFrom.slice(0, 40)}`);
  } finally {
    g.document = undefined;
    g.Image = undefined;
  }
});

// The SVG is parsed as XML, and XML defines five entities. `&nbsp;` is not one of them: the image
// fails to load, silently, and the button reports a timeout that says nothing about why.
test('the card SVG names no entity XML does not define', () => {
  const svg = shareCardSvg(base);
  assert.match(svg, /<foreignObject[^>]*>\s*<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  const entities = [...svg.matchAll(/&([a-z]+);/gi)].map((m) => m[1]);
  const allowed = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
  assert.deepEqual(
    entities.filter((e) => !allowed.has(e!)),
    [],
  );
});
