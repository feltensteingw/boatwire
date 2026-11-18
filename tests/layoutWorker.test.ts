import { afterEach, describe, expect, it, vi } from 'vitest';
import { exampleProject } from '../src/model/examples';
import { generateIdeal } from '../src/engine/generate';
import type { LayerSettings } from '../src/model/types';

const layers: LayerSettings = { dc: true, ac: true, negatives: 'full', signal: true, grounding: false, labels: { gauge: true, protection: true, current: false, length: false, vdrop: false, parts: false } };

/** A Web Worker whose script never loads: it only ever fires 'error'. */
class BrokenWorker {
  private onError: ((e: { message: string }) => void)[] = [];
  addEventListener(type: string, fn: (e: { message: string }) => void) {
    if (type === 'error') this.onError.push(fn);
  }
  postMessage() {
    setTimeout(() => this.onError.forEach((fn) => fn({ message: 'script failed to load' })), 0);
  }
  terminate() {}
}

describe('layout engine loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('falls back to in-page layout with identical results when the worker cannot start', async () => {
    const p = exampleProject();
    const d = generateIdeal(p, p.scenarios[0]);

    vi.resetModules();
    const plain = await (await import('../src/layout/layout')).autoLayout(d, layers);

    vi.resetModules();
    vi.stubGlobal('Worker', BrokenWorker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viaFallback = await (await import('../src/layout/layout')).autoLayout(d, layers);

    expect(warn).toHaveBeenCalled();
    expect(viaFallback.nodes.map((n) => [n.id, n.x, n.y])).toEqual(plain.nodes.map((n) => [n.id, n.x, n.y]));
    expect(viaFallback.edges.every((e) => e.points && e.points.length >= 2)).toBe(true);
  });
});
