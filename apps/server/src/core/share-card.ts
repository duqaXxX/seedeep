/**
 * The share card's markup and the SVG that carries it — pure string building, no DOM and no
 * browser, which is what lets the page that already displays the data draw its own PNG.
 *
 * It used to live in `server/` and be rasterised by a headless Chrome the server spawned through
 * playwright. That was a second browser, launched to draw something the FIRST one already had the
 * data for: the client posted the whole payload and the server added nothing to it. The round trip
 * is gone, and with it the 12 MB dependency that could not be bundled into the executable at all.
 */

export interface ShareCardFinding {
  kind: string;
  severity: 'warn' | 'crit';
  text: string;
  cost?: string;
}

/** What the turn DID — the context a bare verdict cannot give (see the card's stat strip). */
export interface ShareCardStats {
  apiCalls: number;
  toolCalls: number;
  subagents: number;
  /** Tokens re-read from cache — free volume, deliberately kept out of `billable`. */
  cacheRead: number;
  model: string | null;
  effort: string | null;
}

export interface ShareCardData {
  turnIndex: number;
  turnOrdinal: number;
  totalTurns: number;
  durationMs: number | null;
  date: string;
  severity: 'good' | 'warn' | 'crit';
  /** Multiplier vs p50, e.g. "3.1". Null when baseline unavailable or p50=0. */
  mult: string | null;
  billable: number;
  p50: number | null;
  /** Baseline percentiles for the scale bar; null when there is no usable bucket. */
  p90?: number | null;
  p95?: number | null;
  findings: ShareCardFinding[];
  stats?: ShareCardStats;
}

/** The card's layout size in CSS pixels. The PNG is this × {@link CARD_DPR}. */
export const CARD_W = 1200,
  CARD_H = 628;
/**
 * Pixels per CSS pixel in the PNG. At 1 the card was one image pixel per CSS pixel, so every
 * surface that resamples it — the preview modal, a HiDPI screen, a social timeline that scales
 * 1200px down to ~600 — softened the text it was carrying. The layout does not change; only how
 * many pixels describe it.
 */
export const CARD_DPR = 2;

// ─── formatting helpers ────────────────────────────────────────────────────────

function kTok(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + (s % 60 ? String(s % 60).padStart(2, '0') + 's' : '');
}

/**
 * Tokens the findings account for. Only a finding whose `cost` is an ABSOLUTE amount counts: a
 * relative cost ("3.4×", "77% of the turn") summed as tokens was silent nonsense.
 * Returns 0 when nothing in the list carries a token figure.
 */
export function attributedTokens(findings: ShareCardFinding[]): number {
  let sum = 0;
  for (const f of findings) {
    const m = /^~?([\d.]+)([kM]?)$/.exec((f.cost ?? '').trim());
    if (!m) continue;
    sum += parseFloat(m[1]!) * (m[2] === 'k' ? 1e3 : m[2] === 'M' ? 1e6 : 1);
  }
  return sum;
}

/** Short model label ("opus 4.8"), or '' — the card has no room for a full model id. */
function shortModel(model: string | null): string {
  if (!model) return '';
  const m = /claude-(opus|sonnet|haiku|fable)-?(\d)-?(\d)?/.exec(model);
  if (!m) return model.replace(/^claude-/, '');
  return m[1] + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
}

/**
 * The card as an SVG document carrying its markup in a `<foreignObject>` — what a browser can load
 * into an `Image` and draw onto a canvas.
 *
 * The SVG is parsed as XML, which is the whole constraint on {@link buildShareCardHtml}: the markup
 * has to be well formed and may name only the five entities XML defines. `&nbsp;` is NOT one of
 * them — it is an HTML entity, and it makes the image fail to load with no error anywhere. That is
 * why the template writes `&#160;`.
 */
export function shareCardSvg(d: ShareCardData): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" ` +
    `viewBox="0 0 ${CARD_W} ${CARD_H}">` +
    `<foreignObject width="100%" height="100%">${buildShareCardHtml(d)}</foreignObject></svg>`
  );
}

// ─── HTML template ─────────────────────────────────────────────────────────────

/**
 * The card's markup, as an XML-well-formed fragment for {@link shareCardSvg} — not a document:
 * it carries no doctype and no `<body>`, and its root div declares the XHTML namespace because
 * inside an SVG that is what tells the browser to lay it out as HTML.
 *
 * Exported for tests: the PNG is not assertable, the markup is.
 */
export function buildShareCardHtml(d: ShareCardData): string {
  const sevColor = d.severity === 'crit' ? '#fb7185' : d.severity === 'warn' ? '#fbbf24' : '#6ee7b7';
  const sevLabel = d.severity === 'crit' ? 'CRITICAL' : d.severity === 'warn' ? 'WARNING' : 'CLEAN';
  const sevBg =
    d.severity === 'crit'
      ? 'rgba(251,113,133,.12)'
      : d.severity === 'warn'
        ? 'rgba(251,191,36,.10)'
        : 'rgba(110,231,183,.10)';
  const glowRgb = d.severity === 'crit' ? '251,113,133' : d.severity === 'warn' ? '251,191,36' : '110,231,183';

  // The hero is the TOKEN COUNT, not the multiplier: it is true with or without a baseline, and
  // "3.4×" alone never said 3.4× of what. The multiplier becomes the line under it, where it
  // reads as the comparison it is.
  const heroNum = kTok(d.billable);
  const compare =
    d.mult && d.p50
      ? `${d.mult}× your median turn (${kTok(d.p50)})`
      : d.p50
        ? `your median turn is ${kTok(d.p50)}`
        : 'no personal baseline yet';

  // Scale bar: where this turn sits against the personal p50/p90/p95. Drawn only when the
  // baseline really has them — a bar with invented ticks would be the worst kind of chart.
  const scale = (() => {
    if (!d.p50 || !d.p90 || !d.p95) return '';
    const span = Math.max(d.p95 * 1.25, d.billable * 1.1);
    const at = (v: number) => Math.min(100, (100 * v) / span);
    const tick = (v: number, label: string) => `
      <div style="position:absolute;left:${at(v).toFixed(1)}%;top:0;bottom:0;width:1px;background:#26364e"></div>
      <div style="position:absolute;left:${at(v).toFixed(1)}%;top:22px;transform:translateX(-50%);
        font:13px/1 ui-monospace,monospace;color:#93a6c2;white-space:nowrap">${label}</div>`;
    return `<div style="position:relative;height:46px;margin-top:22px">
      <div style="position:absolute;left:0;right:0;top:6px;height:9px;border-radius:5px;background:#101a29"></div>
      <div style="position:absolute;left:0;top:6px;height:9px;border-radius:5px;width:${at(d.billable).toFixed(1)}%;
        background:${sevColor};box-shadow:0 0 22px rgba(${glowRgb},.45)"></div>
      ${tick(d.p50, 'p50')}${tick(d.p90, 'p90')}${tick(d.p95, 'p95')}
    </div>`;
  })();

  const findingsHtml =
    d.findings.length === 0
      ? `<div style="font:17px/1.55 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;padding:6px 0">
         No waste pattern detected — no cold resume, no oversized subagent output, no compaction, no repeated correction, and the context stayed clear of its limit.
       </div>`
      : d.findings
          .map((f) => {
            const dotCol = f.severity === 'crit' ? '#fb7185' : '#fbbf24';
            return `<div style="display:grid;grid-template-columns:10px 1fr auto;gap:14px;align-items:start;
            padding:11px 0;border-bottom:1px solid #131f30">
          <span style="width:8px;height:8px;border-radius:50%;background:${dotCol};display:inline-block;margin-top:6px"></span>
          <span style="font:17px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e8eef9">${esc(f.text)}</span>
          <span style="font:600 16px/1.45 ui-monospace,monospace;color:${dotCol};white-space:nowrap">${f.cost ? esc(f.cost) : ''}</span>
        </div>`;
          })
          .join('');

  const attributed = attributedTokens(d.findings);
  const attributedLine =
    attributed > 0
      ? `<div style="display:flex;align-items:baseline;gap:10px;margin-top:14px">
         <span style="font:15px/1 ui-sans-serif,system-ui,sans-serif;color:#a8bad4">tokens attributed to findings</span>
         <span style="font:600 17px/1 ui-monospace,monospace;color:${sevColor}">~${kTok(attributed)}</span>
         ${d.billable > 0 ? `<span style="font:15px/1 ui-monospace,monospace;color:#93a6c2">${Math.round((100 * attributed) / d.billable)}% of the turn</span>` : ''}
       </div>`
      : '';

  const s = d.stats;
  const cells: [string, string][] = [
    ['turn', `${d.turnOrdinal} of ${d.totalTurns}`],
    ['duration', fmtDuration(d.durationMs) || '—'],
    ...(s
      ? [
          ['api calls', String(s.apiCalls)] as [string, string],
          ['tool calls', String(s.toolCalls)] as [string, string],
          ['subagents', String(s.subagents)] as [string, string],
          ['cache reads', kTok(s.cacheRead)] as [string, string],
          [
            'model',
            [shortModel(s.model), s.effort && s.effort !== 'unknown' ? s.effort : ''].filter(Boolean).join(' · ') ||
              '—',
          ] as [string, string],
        ]
      : []),
  ];
  const statStrip = cells
    .map(
      ([label, value]) => `
    <div style="flex:1;min-width:0">
      <div style="font:600 12px/1 ui-monospace,monospace;letter-spacing:.11em;text-transform:uppercase;color:#93a6c2;margin-bottom:8px">${esc(label)}</div>
      <div style="font:600 20px/1 ui-sans-serif,system-ui,sans-serif;color:#e8eef9;font-variant-numeric:tabular-nums;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(value)}</div>
    </div>`,
    )
    .join('');

  return `<div xmlns="http://www.w3.org/1999/xhtml" class="card">
<style>
*{box-sizing:border-box;margin:0;padding:0}
.card{
  width:1200px;height:628px;overflow:hidden;
  background:#05070c;
  background-image:
    radial-gradient(ellipse 700px 280px at 88% 10%,rgba(167,139,250,.06),transparent),
    radial-gradient(ellipse 560px 380px at 4% 92%,rgba(56,189,248,.05),transparent);
  font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
  color:#dde3ef;position:relative;
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,#38bdf8 0%,#818cf8 48%,#c084fc 100%);
}
.inner{padding:38px 56px 30px;display:flex;flex-direction:column;height:628px;position:relative;z-index:1}
.top{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.wordmark{font:700 19px/1 ui-monospace,monospace;letter-spacing:.04em;
  background:linear-gradient(90deg,#38bdf8,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}
.kicker{font:600 13px/1 ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase;color:#93a6c2}
.badge{margin-left:auto;font:700 13px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;
  padding:7px 15px;border-radius:20px;border:1px solid ${sevColor};color:${sevColor};background:${sevBg}}
/* The card is a fixed 1200×628 frame holding 0-3 findings: the two columns are CENTRED in the
   space between the header and the stat strip, so a one-finding card does not leave a dead
   lower half (the original layout pinned everything to the top and did exactly that). */
.main{display:grid;grid-template-columns:400px 1fr;column-gap:56px;align-items:center;flex:1}
.hero{font:700 92px/.86 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.045em;
  font-variant-numeric:tabular-nums;color:${sevColor};text-shadow:0 0 60px rgba(${glowRgb},.28)}
.hero-unit{font:600 24px/1 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;letter-spacing:0;margin-left:10px}
.hero-label{font:16px/1.4 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;margin-top:14px}
.hero-cmp{font:15px/1.4 ui-monospace,monospace;color:#93a6c2;margin-top:6px}
.fhdr{font:700 13px/1 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;
  color:#93a6c2;margin-bottom:14px;display:flex;align-items:center;gap:12px}
.fhdr::after{content:'';flex:1;height:1px;background:#131f30}
.strip{display:flex;gap:26px;margin-top:auto;padding:22px 0 18px;border-top:1px solid #131f30;border-bottom:1px solid #0d1725}
.footer{display:flex;align-items:center;justify-content:space-between;padding-top:14px}
.safe{font:13px/1 ui-monospace,monospace;color:#93a6c2;display:flex;align-items:center;gap:7px}
.date{font:13px/1 ui-monospace,monospace;color:#93a6c2}
</style>
<div class="inner">
  <div class="top">
    <span class="wordmark">seedeep</span>
    <span class="kicker">turn verdict</span>
    <span class="badge">${sevLabel}</span>
  </div>
  <div class="main">
    <div>
      <div class="hero">${esc(heroNum)}<span class="hero-unit">tokens</span></div>
      <div class="hero-label">spent on this turn — input, output and cache writes</div>
      <div class="hero-cmp">${esc(compare)}</div>
      ${scale}
    </div>
    <div>
      <div class="fhdr">findings${d.findings.length ? '&#160;·&#160;' + d.findings.length : ''}</div>
      ${findingsHtml}
      ${attributedLine}
    </div>
  </div>
  <div class="strip">${statStrip}</div>
  <div class="footer">
    <div class="safe">🔒 Safe to share — no paths, project names or prompt text</div>
    <div class="date">${esc(d.date)}</div>
  </div>
</div>
</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
