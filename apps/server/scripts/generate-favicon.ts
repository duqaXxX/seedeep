/**
 * Generates public/favicon.svg and public/favicon.ico from one description of the mark.
 * Run once (or after any icon change): bun run scripts/generate-favicon.ts
 *
 * No external dependencies — ICO is written as a raw BMP-in-ICO binary.
 *
 * The mark is a LENS WITH NO HANDLE: a thick ring of glass with a trace inside it — three spans
 * stepping to the right, the shape the Trace tab draws. It is described here in the same unit
 * square the tray's Rust renderer uses (`apps/tray/src-tauri/src/icon.rs`), from constants with
 * the same names and values, so the two surfaces cannot drift apart by eye.
 *
 * The 16×16 ICO is RASTERISED from that geometry rather than hand-plotted on a grid — with an
 * optical size of its own, see `isInkSmall`. A literal pixel grid, which is what this file used to
 * carry, means the small icon is a DRAWING of the large one and can disagree with it silently.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const BG = '#0b0d12';
const INK = '#7dd3fc';

// ─── the mark, in the unit square ────────────────────────────────────────────
// Mirrors icon.rs: GLASS_R / GLASS_STROKE / SPANS / SPAN_H.

const GLASS_R = 0.37;
const GLASS_STROKE = 0.075;
/** (left, right, centre-y) — each span starts where the one above it is about half done. */
const SPANS: [number, number, number][] = [
  [0.34, 0.5, 0.38],
  [0.4, 0.58, 0.5],
  [0.45, 0.63, 0.62],
];
const SPAN_H = 0.075;

/** Fraction of the tile the mark occupies, leaving the rounded square a margin of its own. */
const FIT = 0.92;

// ─── SVG ─────────────────────────────────────────────────────────────────────
// 32×32 viewBox for crisp rendering at browser icon sizes (16 → 64 px).

const S = 32;
const u = (v: number) => +(16 + (v - 0.5) * S * FIT).toFixed(2); // unit → viewBox
const len = (v: number) => +(v * S * FIT).toFixed(2);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="5" fill="${BG}"/>
  <!-- the glass: one thick ring, no handle -->
  <circle cx="16" cy="16" r="${len(GLASS_R - GLASS_STROKE / 2)}" fill="none" stroke="${INK}" stroke-width="${len(GLASS_STROKE)}"/>
  <!-- the trace it is over: three spans stepping right -->
  <g stroke="${INK}" stroke-width="${len(SPAN_H)}" stroke-linecap="round">
${SPANS.map(([l, r, cy]) => `    <line x1="${u(l)}" y1="${u(cy)}" x2="${u(r)}" y2="${u(cy)}"/>`).join('\n')}
  </g>
</svg>`;

await Bun.write(join(PUBLIC, 'favicon.svg'), SVG);
console.log('✓ public/favicon.svg');

// ─── ICO (16×16, 32-bit BMP, no compression) ─────────────────────────────────

const W = 16;
const H = 16;
const SS = 4;

/**
 * The mark at 16 px: the glass, and TWO spans.
 *
 * An optical size, not a different mark. Inside eleven pixels three spans leave under a pixel of
 * gap between them and merge into a block; two keep the step that says "trace" rather than
 * "list", and they are drawn a touch heavier than the full mark's so they survive the threshold
 * below.
 */
const SMALL_GLASS_STROKE = 0.085;
const SMALL_SPANS: [number, number, number][] = [
  [0.32, 0.52, 0.4],
  [0.42, 0.64, 0.6],
];
const SMALL_SPAN_H = 0.1;
const SMALL_FIT = 0.98;

/** Distance from a point to a horizontal segment. */
function segDistance(x: number, y: number, x1: number, x2: number, cy: number): number {
  const t = Math.min(Math.max((x - x1) / (x2 - x1), 0), 1);
  return Math.hypot(x - (x1 + t * (x2 - x1)), y - cy);
}

function isInkSmall(x: number, y: number): boolean {
  const r = Math.hypot(x - 0.5, y - 0.5);
  if (Math.abs(r - (GLASS_R - SMALL_GLASS_STROKE / 2)) <= SMALL_GLASS_STROKE / 2) return true;
  return SMALL_SPANS.some(([l, rt, cy]) => segDistance(x, y, l, rt, cy) <= SMALL_SPAN_H / 2);
}

/** Coverage of one pixel, 0..1, supersampled. */
function coverage(px: number, py: number): number {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / W;
      const y = (py + (sy + 0.5) / SS) / H;
      if (isInkSmall(0.5 + (x - 0.5) / SMALL_FIT, 0.5 + (y - 0.5) / SMALL_FIT)) hits++;
    }
  }
  return hits / (SS * SS);
}

const hexToBgra = (hex: string): readonly number[] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0xff];
};
const BG_BGRA = hexToBgra(BG);
const INK_BGRA = hexToBgra(INK);

const AND_ROW_BYTES = Math.ceil(W / 32) * 4; // pad to 32-bit boundary → 4
const AND_SIZE = H * AND_ROW_BYTES; // 64
const BMP_SIZE = 40 + W * H * 4 + AND_SIZE; // header + XOR mask + AND mask

const buf = Buffer.alloc(6 + 16 + BMP_SIZE);
let p = 0;

function u16(v: number) {
  buf.writeUInt16LE(v, p);
  p += 2;
}
function u32(v: number) {
  buf.writeUInt32LE(v, p);
  p += 4;
}
function u8(v: number) {
  buf[p++] = v;
}

// ICONDIR
u16(0); // idReserved
u16(1); // idType = 1 (ICO)
u16(1); // idCount

// ICONDIRENTRY
u8(W); // bWidth
u8(H); // bHeight
u8(0); // bColorCount (32-bit has no palette)
u8(0); // bReserved
u16(1); // wPlanes
u16(32); // wBitCount
u32(BMP_SIZE); // dwBytesInRes
u32(6 + 16); // dwImageOffset

// BITMAPINFOHEADER
u32(40); // biSize
u32(W); // biWidth
u32(H * 2); // biHeight — double (XOR mask + AND mask stacked)
u16(1); // biPlanes
u16(32); // biBitCount
u32(0); // biCompression (BI_RGB)
u32(0); // biSizeImage
u32(0); // biXPelsPerMeter
u32(0); // biYPelsPerMeter
u32(0); // biClrUsed
u32(0); // biClrImportant

// XOR mask — pixel data in bottom-to-top row order, BGRA per pixel.
// Thresholded rather than blended: an ICO this small is read as a silhouette, and half-covered
// pixels that keep their alpha turn the spans to mush.
for (let row = H - 1; row >= 0; row--) {
  for (let col = 0; col < W; col++) {
    const c = coverage(col, row) >= 0.42 ? INK_BGRA : BG_BGRA;
    u8(c[0]);
    u8(c[1]);
    u8(c[2]);
    u8(c[3]);
  }
}

// AND mask — all zeros: every pixel fully opaque
for (let i = 0; i < AND_SIZE; i++) u8(0);

await Bun.write(join(PUBLIC, 'favicon.ico'), buf);
console.log('✓ public/favicon.ico');
