import { defineConfig, devices } from '@playwright/test';
const evidenceRoot = process.env.EVIDENCE_DIR ?? '.pilot-evidence';
const appURL = process.env.TEST_APP_URL ?? `http://127.0.0.1:${process.env.APP_PORT ?? 5173}`;
export default defineConfig({
  testDir: './tests/journeys',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${evidenceRoot}/playwright-report` }]],
  outputDir: `${evidenceRoot}/browser`,
  use: {
    baseURL: appURL,
    trace: 'on', screenshot: 'on',
    launchOptions: { executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
  ],
  webServer: { command: 'npm run dev', url: appURL, reuseExistingServer: !process.env.CI, timeout: 60000 },
});
