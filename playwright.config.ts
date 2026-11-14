import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3210);
const external = process.env.E2E_BASE_URL; // set to run the browser suite against a deployed URL

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { baseURL: external ?? `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /compare\.spec/ },
  ],
  webServer: external ? undefined : {
    command: 'node --disable-warning=ExperimentalWarning src/main.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), RC_TEST_HOOKS: '1', RC_DATA_DIR: path.join(os.tmpdir(), `rc-e2e-${Date.now()}`) },
  },
});
