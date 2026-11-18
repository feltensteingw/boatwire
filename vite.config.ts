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
    build: { target: 'es2020' },
    define: {
      __APP_VERSION__: JSON.stringify(info.version),
      __APP_COMMIT__: JSON.stringify(command === 'serve' ? `${info.sha}-dev` : info.sha),
      __APP_BUILD_TIME__: JSON.stringify(info.time),
    },
    test: { globals: true, environment: 'node' },
  } as never;
});
