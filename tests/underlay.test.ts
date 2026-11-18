import { describe, expect, it } from 'vitest';
import { fitWithin, isPdf, placeUnderlay, roundRect, scaleRect, UNDERLAY_DEFAULT_WIDTH, UNDERLAY_MIN_WIDTH } from '../src/model/underlay';

describe('underlay helpers', () => {
  it('fitWithin scales the long side down and never up', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(1500, 3000, 2000)).toEqual({ width: 1000, height: 2000 });
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600, 2000)).toEqual({ width: 0, height: 0 });
  });

  it('places on an empty canvas at the origin with the default width', () => {
    expect(placeUnderlay(2)).toEqual({ x: 0, y: 0, width: UNDERLAY_DEFAULT_WIDTH, height: UNDERLAY_DEFAULT_WIDTH / 2 });
  });

  it('covers the existing drawing', () => {
    const r = placeUnderlay(1, { nodeBounds: { x: 10, y: 20, width: 900, height: 1200 } });
    expect(r.x).toBe(10);
    expect(r.y).toBe(20);
    expect(r.width).toBeGreaterThanOrEqual(900);
    expect(r.height).toBeGreaterThanOrEqual(1200);
  });

  it('keeps position and width when replacing, with the new aspect', () => {
    expect(placeUnderlay(4 / 3, { previous: { x: 5, y: 6, width: 800, height: 100 } })).toEqual({ x: 5, y: 6, width: 800, height: 600 });
  });

  it('guards against a bad aspect ratio', () => {
    expect(placeUnderlay(NaN).height).toBe(UNDERLAY_DEFAULT_WIDTH);
  });

  it('scaleRect keeps the aspect ratio and a minimum width', () => {
    expect(scaleRect({ x: 0, y: 0, width: 400, height: 200 }, 200)).toEqual({ x: 0, y: 0, width: 600, height: 300 });
    expect(scaleRect({ x: 0, y: 0, width: 400, height: 200 }, -1000).width).toBe(UNDERLAY_MIN_WIDTH);
    expect(roundRect({ x: 1.4, y: 1.6, width: 2.5, height: 3.49 })).toEqual({ x: 1, y: 2, width: 3, height: 3 });
  });

  it('detects PDFs by type or extension', () => {
    expect(isPdf('wiring.PDF', '')).toBe(true);
    expect(isPdf('x', 'application/pdf')).toBe(true);
    expect(isPdf('photo.jpg', 'image/jpeg')).toBe(false);
  });
});
