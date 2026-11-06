import { existsSync } from 'node:fs';
import { ENV_FILE, loadRepoEnv } from './lib/env.mjs';
import { color, log } from './lib/proc.mjs';

async function answers(url, accept) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return accept(res.status, await res.text());
  } catch {
    return false;
  }
}

async function status(env) {
  console.log(`\n${color(1, 'Hostile local stack')} ${color(90, '(started by pnpm dev)')}\n`);
  const checks = [
    [
      `API      http://127.0.0.1:${env.API_PORT}/api/health`,
      () =>
        answers(
          `http://127.0.0.1:${env.API_PORT}/api/health`,
          (s, body) => s < 500 && /"status"\s*:/.test(body),
        ),
    ],
    [
      `web      http://127.0.0.1:${env.WEB_PORT}/`,
      () => answers(`http://127.0.0.1:${env.WEB_PORT}/`, (s) => s < 500),
    ],
    [
      `LiveKit  http://127.0.0.1:${env.LIVEKIT_PORT}/`,
      () =>
        answers(
          `http://127.0.0.1:${env.LIVEKIT_PORT}/`,
          (s, body) => s === 200 && body.trim() === 'OK',
        ),
    ],
  ];
  for (const [label, probe] of checks) {
    if (await probe()) log.ok(`${label}  responding`);
    else log.info(`${label}  not responding`);
  }

  console.log(`
Commands:
  pnpm dev                              start API, web client and LiveKit; Ctrl+C stops them
  pnpm check                            full diagnosis
`);
}

const command = process.argv[2];
if (command !== 'status') {
  console.log('Usage: node scripts/stack.mjs status');
  process.exit(command === '--help' || command === '-h' ? 0 : 1);
}
if (!existsSync(ENV_FILE)) {
  log.fail(`.env not found at ${ENV_FILE}. Run \`pnpm setup:local\` first.`);
  process.exit(1);
}
await status(loadRepoEnv());
