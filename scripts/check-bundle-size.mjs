// Bundle-size budget, run after `vite build` (and so in CI, which runs `npm run build`).
//
// Sums the gzipped size of everything index.html loads up front (entry script, preloaded
// chunks, stylesheets) and fails the build if it exceeds the budget. Chunks loaded on demand
// (layout worker, Firebase, PDF import, help guide, Compare, Reports) do not count.
//
// Raise the budget only on purpose: prefer loading new heavy code lazily.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 250; // gzipped. Was ~731 KB before code splitting; ~176 KB after.
const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const files = new Set();
for (const m of html.matchAll(/<script[^>]*\bsrc="\/?([^"]+)"/g)) files.add(m[1]);
for (const m of html.matchAll(/<link[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*\bhref="\/?([^"]+)"/g)) {
  if (!/^https?:/.test(m[1])) files.add(m[1]);
}
if (!files.size) {
  console.error('check-bundle-size: found no local scripts or styles in dist/index.html');
  process.exit(1);
}

let total = 0;
const rows = [];
for (const f of files) {
  const kb = gzipSync(readFileSync(join(dist, f))).length / 1024;
  total += kb;
  rows.push(`  ${kb.toFixed(1).padStart(7)} KB  ${f}`);
}
console.log(`Initial download (gzipped):\n${rows.join('\n')}\n  ${total.toFixed(1).padStart(7)} KB  total, budget ${BUDGET_KB} KB`);
if (total > BUDGET_KB) {
  console.error(`\nBundle budget exceeded by ${(total - BUDGET_KB).toFixed(1)} KB. Load the new code lazily (dynamic import) or raise BUDGET_KB in scripts/check-bundle-size.mjs on purpose.`);
  process.exit(1);
}
