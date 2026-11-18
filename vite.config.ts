import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Build stamp shown in the header so you can tell which deploy you are looking at. */
function buildInfo() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  let sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      sha = 'local';
    }
  }
  return { version: pkg.version, sha, time: new Date().toISOString() };
}

export default defineConfig(({ command }) => {
  const info = buildInfo();
  return {
    plugins: [
      react(),
      // Offline support and "install as an app" (see src/pwa.ts).
      VitePWA({
        // A new version waits until the user reloads; it never swaps the app out mid-edit.
        registerType: 'prompt',
        manifest: {
          name: 'BoatWire — Sailboat Electrical Designer',
          short_name: 'BoatWire',
          description: "Design and check a sailboat's 12 / 24 V and AC electrical system.",
          theme_color: '#0f2b46',
          background_color: '#0f2b46',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Everything needed to design a boat offline: the app, the layout engine's worker, PDF
          // import and the fonts. Left to load from the network when wanted: Firebase (sign-in
          // needs a connection anyway), the layout engine's in-page fallback, and font files
          // for scripts the interface does not use.
          globPatterns: ['**/*.{js,mjs,css,html,png,woff2}'],
          globIgnores: ['**/firebase-*.js', '**/elk.bundled-*.js', '**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*.woff2'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          navigateFallback: '/index.html',
          // Firebase's own pages (sign-in helper) are never answered from the offline copy.
          navigateFallbackDenylist: [/^\/__\//],
          cleanupOutdatedCaches: true,
          // On the very first visit, take over the open page as soon as the offline copy is ready,
          // so parts loaded later in that session (Reports, the guide) also come from it. This does
          // not affect updates: a new version still waits for the user.
          clientsClaim: true,
        },
      }),
    ],
    // Vite's default 'modules' target (safari14, chrome87…) makes esbuild lower pdf.js's class syntax into
    // helpers that Vite's own import analysis then fails to parse ("Parse error @:1:1"). es2020 avoids that.
    build: {
      target: 'es2020',
      // The ELK fallback and PDF worker are large but load only on demand; scripts/check-bundle-size.mjs
      // guards what the page downloads up front.
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: {
          // Long-lived vendor chunks: a deploy that only changes BoatWire code leaves these
          // file names (and the browser's cached copies) unchanged.
          manualChunks(id: string) {
            if (!id.includes('/node_modules/')) return undefined;
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
            if (/\/node_modules\/(@xyflow|d3-[a-z-]+|classcat|zustand)\//.test(id)) return 'vendor-flow';
            return undefined;
          },
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(info.version),
      __APP_COMMIT__: JSON.stringify(command === 'serve' ? `${info.sha}-dev` : info.sha),
      __APP_BUILD_TIME__: JSON.stringify(info.time),
    },
    // The layout tests run the real ELK engine. On a busy CI machine one can take well over the
    // 5 s default, so allow plenty: a slow test is not a failed test.
    // (Browser tests live in e2e/ and are run by Playwright, not by vitest.)
    test: { globals: true, environment: 'node', testTimeout: 60000, include: ['tests/**/*.test.ts'] },
  } as never;
});
