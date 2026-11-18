import { defineConfig } from '@playwright/test';

// Browser tests (`npm run test:e2e`). They run against a production build of the app, served
// locally, with the in-memory stand-in for the cloud (VITE_CLOUD_FAKE) so sign-in and saving can
// be exercised without an account or a network.
//
// In CI the browser is Playwright's own Chromium (installed by the workflow). On a developer
// machine it uses the Chrome that is already installed, so nothing has to be downloaded.
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run build:e2e && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
