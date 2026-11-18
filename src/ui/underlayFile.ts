// Turn an uploaded photo / scan / PDF into a small data URL for the trace-over underlay.

import type { Underlay } from '../model/types';
import { fitWithin, isPdf, placeUnderlay, UNDERLAY_MAX_CHARS, UNDERLAY_MAX_PX, type Rect } from '../model/underlay';

export const UNDERLAY_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif,.pdf,application/pdf';

/** Read a file and build an Underlay placed per `placeUnderlay`. */
export async function underlayFromFile(file: File, opts: { previous?: Underlay; nodeBounds?: Rect | null } = {}): Promise<Underlay> {
  const source = isPdf(file.name, file.type) ? await renderPdfFirstPage(file) : await loadImage(file);
  const { src, width, height } = encodeSmall(source);
  const rect = placeUnderlay(width / height, opts);
  return {
    src,
    name: file.name,
    ...rect,
    opacity: opts.previous?.opacity ?? 0.5,
    visible: true,
    locked: false,
  };
}

type Drawable = { el: CanvasImageSource; width: number; height: number };

async function loadImage(file: File): Promise<Drawable> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode().catch(() => {
      throw new Error(`This browser cannot read “${file.name}”. Try a PNG, JPEG or PDF.`);
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image is empty.');
    return { el: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    // the decoded image stays usable for drawing after the URL is revoked
    URL.revokeObjectURL(url);
  }
}

async function renderPdfFirstPage(file: File): Promise<Drawable> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = UNDERLAY_MAX_PX / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { el: canvas, width: canvas.width, height: canvas.height };
  } finally {
    void doc.destroy();
  }
}

/** Downscale and compress until the data URL fits the storage budget. */
function encodeSmall(source: Drawable): { src: string; width: number; height: number } {
  let { width, height } = fitWithin(source.width, source.height, UNDERLAY_MAX_PX);
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // flatten transparency (PNG line art) onto white paper
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.el, 0, 0, width, height);
    for (const q of [0.8, 0.65, 0.5]) {
      let src = canvas.toDataURL('image/webp', q);
      if (!src.startsWith('data:image/webp')) src = canvas.toDataURL('image/jpeg', q); // Safari can't encode WebP
      if (src.length <= UNDERLAY_MAX_CHARS) return { src, width, height };
    }
    width = Math.round(width * 0.75);
    height = Math.round(height * 0.75);
  }
  throw new Error('The image is too detailed to store. Try cropping it first.');
}
