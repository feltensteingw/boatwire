// Pure helpers for the trace-over diagram underlay (no DOM access, so they are unit-testable).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest side, in pixels, the stored image is scaled down to. */
export const UNDERLAY_MAX_PX = 2000;
/** Upper bound on the stored data URL, so a project with an underlay still fits in one Firestore document (1 MiB). */
export const UNDERLAY_MAX_CHARS = 600_000;
/** Width (diagram units) a new underlay gets on an empty canvas. */
export const UNDERLAY_DEFAULT_WIDTH = 1200;
/** Smallest width the user can shrink an underlay to. */
export const UNDERLAY_MIN_WIDTH = 100;

/** Scale (w, h) down so the longer side is at most `max`. Never scales up. */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Where to put a freshly uploaded image of the given aspect ratio (width / height).
 * - Replacing an existing underlay: keep its position and width.
 * - Drawing already has components: cover their bounding box (at least default-ish width).
 * - Empty canvas: default width at the origin.
 */
export function placeUnderlay(aspect: number, opts: { previous?: Rect; nodeBounds?: Rect | null } = {}): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (opts.previous) {
    const { x, y, width } = opts.previous;
    return { x, y, width, height: Math.round(width / a) };
  }
  const b = opts.nodeBounds;
  if (b && b.width > 0 && b.height > 0) {
    // cover the drawing: match whichever dimension needs the image to be larger
    const width = Math.round(Math.max(b.width, b.height * a, 600));
    return { x: Math.round(b.x), y: Math.round(b.y), width, height: Math.round(width / a) };
  }
  return { x: 0, y: 0, width: UNDERLAY_DEFAULT_WIDTH, height: Math.round(UNDERLAY_DEFAULT_WIDTH / a) };
}

/** Resize from the bottom-right corner, keeping the aspect ratio. */
export function scaleRect(r: Rect, dx: number): Rect {
  const width = Math.max(UNDERLAY_MIN_WIDTH, r.width + dx);
  return { ...r, width, height: (width * r.height) / r.width };
}

export function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

export function isPdf(name: string, type: string): boolean {
  return type === 'application/pdf' || /\.pdf$/i.test(name);
}
