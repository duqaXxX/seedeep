import { CARD_DPR, CARD_H, CARD_W, type ShareCardData, shareCardSvg } from '../core/share-card.ts';

/**
 * Turns a turn's verdict into a PNG, in the page that is already showing it.
 *
 * The browser rasterises its own SVG: no server, no second browser, no Chrome to have installed —
 * which is why this works from the compiled executable, where the old `POST /api/share-card`
 * answered 500 because playwright cannot be bundled into it.
 */
export async function renderShareCardPng(data: ShareCardData): Promise<Blob> {
  const img = new Image();
  // A `data:` URL, never `URL.createObjectURL`: an SVG loaded from a `blob:` URL is treated as
  // cross-origin and TAINTS the canvas — `toBlob` then throws "Tainted canvases may not be
  // exported" and no PNG is produced (measured in Chrome before this was written).
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shareCardSvg(data))}`;

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    // The browser reports XML that will not parse as a plain load failure, with nothing on the
    // console and no detail to pass on — so the message says where to look instead of guessing.
    img.onerror = () => reject(new Error('the card SVG did not load — malformed markup?'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * CARD_DPR;
  canvas.height = CARD_H * CARD_DPR;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  ctx.scale(CARD_DPR, CARD_DPR);
  ctx.drawImage(img, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no PNG'))), 'image/png');
  });
}
