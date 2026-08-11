import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 5178);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Chrome's fake capture devices stand in for a phone camera: the QR stream a
// sender would display is rendered to a Y4M file and fed in as the webcam.
// Built by tests/e2e/fixtures/camera.js before the suite runs.
const FAKE_CAMERA = new URL('./tests/e2e/.artifacts/camera.y4m', import.meta.url).pathname;

const chromiumWithCamera = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${FAKE_CAMERA}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
};

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.js',
  fullyParallel: false, // peers discover each other through one shared server
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['junit', { outputFile: 'playwright-results.xml' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    permissions: ['camera'],
  },

  projects: [
    {
      name: 'chromium',
      use: chromiumWithCamera,
      testIgnore: /webkit\.spec\.js/,
    },
    {
      // WebKit is the engine behind iOS Safari — the platform we cannot put a
      // real device in front of. It has no fake-camera support, so it covers
      // what it can: layout, the SCTP ceiling that broke large sends, and
      // whether a transfer survives between two WebKit peers.
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: /webkit\.spec\.js/,
    },
    {
      name: 'mobile',
      use: { ...chromiumWithCamera, ...devices['Pixel 5'], launchOptions: chromiumWithCamera.launchOptions },
      testMatch: /responsive\.spec\.js/,
    },
  ],

  webServer: [
    {
      command: 'node ../backend/server.js',
      url: 'http://localhost:3002/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: '3002' },
    },
    {
      command: `npx vite --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
