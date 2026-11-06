import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-packaged',
  globalSetup: './e2e-desktop/global-setup.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
