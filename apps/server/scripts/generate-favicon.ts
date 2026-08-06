/**
 * Generates public/favicon.svg and public/favicon.ico from a single pixel-art eye design.
 * Run once (or after any icon change): bun run scripts/generate-favicon.ts
 *
 * No external dependencies — ICO is written as a raw BMP-in-ICO binary.
 * The SVG is the primary source of truth; the ICO is a 16×16 pixel-art version
 * for legacy browsers that do not support SVG favicons.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

// ─── SVG ─────────────────────────────────────────────────────────────────────
// Eye icon in seedeep's dark palette.  Uses a 32×32 viewBox for crisp rendering
// at browser icon sizes (16 → 64 px).

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="5" fill="#0b0d12"/>
  <!-- eye outline (almond) -->
  <path d="M2 16 Q16 3 30 16 Q16 29 2 16Z" fill="#0b0d12" stroke="#7dd3fc" stroke-width="2.2"/>
  <!-- iris -->
  <circle cx="16" cy="16" r="6.5" fill="#7dd3fc"/>
  <!-- pupil -->
  <circle cx="16" cy="16" r="3" fill="#0b0d12"/>
  <!-- light reflection -->
  <circle cx="19" cy="13" r="1.4" fill="#e0f2fe" opacity="0.7"/>
</svg>`;

await Bun.write(join(PUBLIC, 'favicon.svg'), SVG);
console.log('✓ public/favicon.svg');

// ─── ICO (16×16, 32-bit BMP, no compression) ─────────────────────────────────
// Pixel grid: 0 = bg (#0b0d12), 1 = blue (#7dd3fc).
// Row 0 = top of the image.  Symmetric eye centered at column ~7.5.

const GRID: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], //  0
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], //  1
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], //  2
  [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0], //  3  eye top
  [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], //  4
  [0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0], //  5  iris top
  [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0], //  6
  [0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0], //  7  pupil gap
  [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0], //  8
  [0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0], //  9  iris bottom
  [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], // 10
  [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0], // 11  eye bottom
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 12
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 13
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 14
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 15
];

// BGRA (the format used in BMP/ICO pixel data)
const BG_BGRA = [0x12, 0x0d, 0x0b, 0xff] as const;
const BLUE_BGRA = [0xfc, 0xd3, 0x7d, 0xff] as const;

const W = 16;
const H = 16;

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

// XOR mask — pixel data in bottom-to-top row order, BGRA per pixel
for (let row = H - 1; row >= 0; row--) {
  for (let col = 0; col < W; col++) {
    const c = GRID[row][col] ? BLUE_BGRA : BG_BGRA;
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
