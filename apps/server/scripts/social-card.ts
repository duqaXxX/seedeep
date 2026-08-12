/**
 * Generates docs/assets/social-card.png — the image GitHub shows when the repository's link is
 * shared. Run: bun run social-card
 *
 * A build output like every other figure in docs/assets, never a picture somebody assembled: the
 * mark is read from public/favicon.svg and the palette from the client's own stylesheets, so a
 * change to either is one re-run away rather than a redraw. GitHub wants PNG/JPG/GIF under 1 MB and
 * recommends 1280×640; this renders exactly that, at scale 1.
 *
 * Uploading it is manual — GitHub exposes no REST endpoint for the social preview, only
 * Settings → General → Social preview.
 *
 * LIMIT: the wordmark is set in the rendering machine's system font stack, so regenerating this on
 * Linux will not produce the identical file it produces on macOS. The layout is unaffected.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MARK = join(ROOT, 'apps/server/public/favicon.svg');
const OUT = join(ROOT, 'docs/assets/social-card.png');

const WIDTH = 1280;
const HEIGHT = 640;

// The client's own tokens (public/css), so the card cannot drift from the product it advertises.
const C = {
  bg: '#0b0d12',
  panel: '#0e1420',
  border: '#1e2739',
  hi: '#eef2fb',
  lo2: '#9aa7c2',
  agent: '#7dd3fc',
  cache: '#38bdf8',
  create: '#a78bfa',
  good: '#6ee7b7',
  warn: '#fbbf24',
};

/** Renders the social preview to docs/assets/social-card.png. Requires Chrome (playwright-core). */
async function main(): Promise<void> {
  const mark = await Bun.file(MARK).text();

  // The bar along the bottom is the product's own subject — a context window filling, in the same
  // colours the app gives each kind of token. It is decoration only in the sense that no number is
  // claimed by it.
  const bar = [
    { w: 34, c: C.agent },
    { w: 21, c: C.cache },
    { w: 13, c: C.create },
    { w: 8, c: C.good },
    { w: 5, c: C.warn },
  ];

  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${WIDTH}px;height:${HEIGHT}px}
    body{
      background:${C.bg};
      font-family:ui-sans-serif,-apple-system,"SF Pro Display",Inter,system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;
      position:relative;overflow:hidden;
    }
    /* A single soft light behind the mark, so the flat background has a centre. */
    .glow{position:absolute;left:190px;top:50%;width:760px;height:760px;transform:translateY(-50%);
      background:radial-gradient(circle,rgba(125,211,252,.13),transparent 62%);}
    /* A few pixels above the true centre: the bar owns the bottom edge, and an optically centred
       block sits slightly high when something anchors the foot of the frame. */
    .lockup{display:flex;align-items:center;gap:52px;position:relative;z-index:1;margin-bottom:12px}
    .mark{width:196px;height:196px;flex:none;filter:drop-shadow(0 10px 34px rgba(125,211,252,.22))}
    .mark svg{width:100%;height:100%;display:block;border-radius:30px}
    .name{font-size:104px;font-weight:700;letter-spacing:-3.5px;color:${C.hi};line-height:1}
    .tag{margin-top:16px;font-size:33px;font-weight:400;color:${C.lo2};letter-spacing:-.3px}
    .rule{margin-top:26px;display:flex;align-items:center;gap:14px}
    .rule span{font-size:19px;letter-spacing:2.6px;text-transform:uppercase;color:${C.agent};opacity:.85}
    .rule i{display:block;width:54px;height:2px;background:${C.agent};opacity:.5}
    /* The window bar: full width, flush to the bottom edge. */
    .bar{position:absolute;left:0;right:0;bottom:0;height:9px;display:flex;background:${C.panel};
      border-top:1px solid ${C.border}}
    .bar b{display:block;height:100%}
  </style>
  <div class="glow"></div>
  <div class="lockup">
    <div class="mark">${mark}</div>
    <div>
      <div class="name">seedeep</div>
      <div class="tag">See deep into your agent&rsquo;s context.</div>
      <div class="rule"><i></i><span>for Claude Code</span></div>
    </div>
  </div>
  <div class="bar">${bar.map((s) => `<b style="width:${s.w}%;background:${s.c}"></b>`).join('')}</div>`;

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: OUT, type: 'png' });
  } finally {
    await browser.close();
  }

  const bytes = (await Bun.file(OUT).arrayBuffer()).byteLength;
  // GitHub refuses anything at or above 1 MB, and a card that is silently rejected looks like a
  // card that was never uploaded.
  if (bytes >= 1_000_000) throw new Error(`${OUT} is ${bytes} bytes — GitHub's limit is under 1 MB`);
  console.log(`  → docs/assets/social-card.png  ${WIDTH}×${HEIGHT}, ${(bytes / 1024).toFixed(0)} KB`);
}

await main();
