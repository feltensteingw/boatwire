import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    plugins: [react()],
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
    test: { globals: true, environment: 'node', testTimeout: 60000 },
  } as never;
});
