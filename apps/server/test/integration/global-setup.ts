import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import type { IntegrationConfig, IntegrationLivekit } from '../support/provided.js';
import {
  findLivekitBinary,
  LIVEKIT_VERSION,
  LOCAL_DIR,
  loadRepoEnv,
  randomSecret,
  renderDevLivekitConfig,
  waitForHttp,
} from '../support/repo-scripts.js';
import { openDatabase } from '../../src/db.js';
import { assertTestDataDir } from '../support/test-database.js';

const LIVEKIT_PORT = 18180;
const LIVEKIT_UDP_PORT = 18182;
const WEBHOOK_SINK_PORT = 18189;

const verbose = Boolean(process.env.INTEGRATION_VERBOSE);

export default async function setup(project: TestProject) {
  const env = loadRepoEnv();
  const parent = mkdtempSync(join(tmpdir(), 'hostile-integration-'));
  const dataDir = join(parent, 'data_test');
  assertTestDataDir(dataDir);

  const database = await openDatabase(dataDir);
  await database.close();

  const { livekit, stop } = await startLivekit(env);
  const config: IntegrationConfig = { dataDir, livekit };
  project.provide('integration', config);
  if (!livekit.running)
    console.warn(`[integration] ${livekit.reason} - LiveKit-dependent tests will be skipped.`);

  return async () => {
    await stop();
    rmSync(parent, { recursive: true, force: true });
  };
}

async function startLivekit(
  env: Record<string, string>,
): Promise<{ livekit: IntegrationLivekit; stop: () => Promise<void> }> {
  const apiKey = 'APIintegration0';
  const apiSecret = randomSecret(32);
  const livekit: IntegrationLivekit = {
    apiKey,
    apiSecret,
    internalUrl: `http://127.0.0.1:${LIVEKIT_PORT}`,
    publicUrl: `ws://localhost:${LIVEKIT_PORT}`,
    running: false,
    reason: null,
  };

  const binary = findLivekitBinary(env);
  if (!binary || binary.missing) {
    livekit.reason = binary?.missing
      ? `LIVEKIT_BIN points at ${binary.path}, which does not exist`
      : 'livekit-server was not found (run `pnpm livekit:install`)';
    return { livekit, stop: async () => undefined };
  }
  if (binary.version && binary.version !== LIVEKIT_VERSION) {
    console.warn(
      `[integration] livekit-server ${binary.version} found; this repository is tested against ${LIVEKIT_VERSION}.`,
    );
  }

  mkdirSync(LOCAL_DIR, { recursive: true });
  const configPath = join(LOCAL_DIR, 'livekit.integration.yaml');
  writeFileSync(
    configPath,
    renderDevLivekitConfig(
      {
        ...env,
        LIVEKIT_PORT: String(LIVEKIT_PORT),
        LIVEKIT_RTC_UDP_PORT: String(LIVEKIT_UDP_PORT),
        LIVEKIT_API_KEY: apiKey,
        LIVEKIT_API_SECRET: apiSecret,
        LIVEKIT_NODE_IP: '127.0.0.1',
        LIVEKIT_LOG_LEVEL: verbose ? 'info' : 'error',
      },
      { apiPort: WEBHOOK_SINK_PORT },
    ),
    { mode: 0o600 },
  );

  const child: ChildProcess = spawn(binary.path, ['--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (chunk: Buffer) => {
    if (verbose) process.stdout.write(`[livekit] ${chunk}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);

  livekit.running = await waitForHttp(`http://127.0.0.1:${LIVEKIT_PORT}/`, 20_000);
  if (!livekit.running)
    livekit.reason = `livekit-server did not answer on port ${LIVEKIT_PORT} within 20s`;

  return {
    livekit,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
