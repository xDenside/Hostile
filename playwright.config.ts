import { defineConfig, devices } from '@playwright/test';
import { ensureSpeechNoiseFile, ensureToneFile } from './e2e/fixtures';
import { installTunnelMode } from './e2e/tunnel-mode';

const mediaArgs = (audioFile: string) => [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${audioFile}`,
  '--allow-loopback-in-peer-connection',
  '--autoplay-policy=no-user-gesture-required',
  '--auto-select-desktop-capture-source=Entire screen',
  '--auto-accept-this-tab-capture',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const CHROMIUM_MEDIA_ARGS = mediaArgs(ensureToneFile());

const speechNoiseFile = ensureSpeechNoiseFile();
const SPEECH_SUITE = /noise-speech\.spec\.ts/;

const ENGINES_SUITE = /other-engines\.spec\.ts|tunnel-files\.spec\.ts/;
const PUBLIC_SMOKE = /tunnel-public-smoke\.spec\.ts/;
const WITHOUT_CHROMIUM_OPTIONS = { permissions: [], launchOptions: { args: [] } };

const TUNNEL_MODE = !!process.env.E2E_TUNNEL_MODE;
if (TUNNEL_MODE) installTunnelMode();

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: TUNNEL_MODE
      ? `http://localhost:${process.env.E2E_GUEST_PORT ?? 5291}`
      : `http://localhost:${process.env.E2E_WEB_PORT ?? 5290}`,
    ...(TUNNEL_MODE ? { storageState: '.local/e2e/tunnel-state.json' } : {}),
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: { args: CHROMIUM_MEDIA_ARGS },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [
        SPEECH_SUITE,
        /other-engines\.spec\.ts/,
        ...(TUNNEL_MODE ? [/tunnel-.*\.spec\.ts/] : []),
        ...(process.env.E2E_PUBLIC_RENDEZVOUS ? [] : [PUBLIC_SMOKE]),
      ],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        viewport: { width: 1280, height: 860 },
      },
    },
    ...(speechNoiseFile
      ? [
          {
            name: 'chromium-speech',
            testMatch: SPEECH_SUITE,
            use: {
              ...devices['Desktop Chrome'],
              channel: 'chromium',
              viewport: { width: 1280, height: 860 },
              launchOptions: { args: mediaArgs(speechNoiseFile) },
            },
          },
        ]
      : []),
    ...(process.env.E2E_OTHER_ENGINES
      ? [
          {
            name: 'firefox',
            testMatch: ENGINES_SUITE,
            use: { ...devices['Desktop Firefox'], ...WITHOUT_CHROMIUM_OPTIONS },
          },
          {
            name: 'webkit',
            testMatch: ENGINES_SUITE,
            use: { ...devices['Desktop Safari'], ...WITHOUT_CHROMIUM_OPTIONS },
          },
          {
            name: 'iphone',
            testMatch: ENGINES_SUITE,
            use: { ...devices['iPhone 15'], ...WITHOUT_CHROMIUM_OPTIONS },
          },
        ]
      : []),
  ],
});
