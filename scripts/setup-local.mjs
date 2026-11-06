import { copyFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import {
  ENV_EXAMPLE,
  ENV_FILE,
  REPO_ROOT,
  loadRepoEnv,
  randomKeyId,
  randomSecret,
  readEnvFile,
  restrictToOwner,
  upsertEnvValues,
} from './lib/env.mjs';
import { findLivekitBinary, LIVEKIT_VERSION } from './lib/livekit.mjs';
import { log, resolveBin, runInherit } from './lib/proc.mjs';

const args = new Set(process.argv.slice(2));
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');

async function ensureEnvFile() {
  if (!existsSync(ENV_FILE)) {
    copyFileSync(ENV_EXAMPLE, ENV_FILE);
    log.ok(`Created ${ENV_FILE} from .env.example`);
  }
  restrictToOwner(ENV_FILE);
  const current = readEnvFile() ?? {};
  const example = readEnvFile(ENV_EXAMPLE) ?? {};
  const updates = {};
  for (const [key, value] of Object.entries(example)) {
    if (!(key in current)) updates[key] = value;
  }
  const merged = { ...current, ...updates };
  for (const [key, value] of Object.entries(merged)) {
    if (value === '__generate__') updates[key] = randomSecret(32);
    if (value === '__generate_key__') updates[key] = randomKeyId();
  }
  if (Object.keys(updates).length) {
    upsertEnvValues(updates);
    const secretKeys = Object.keys(updates).filter((k) => /SECRET|KEY/.test(k));
    log.ok(
      `Filled ${Object.keys(updates).length} missing value(s) in .env${secretKeys.length ? ` (generated: ${secretKeys.join(', ')})` : ''}`,
    );
  } else {
    log.ok('.env already complete; existing secrets left untouched');
  }
  if (merged.HOSTILE_ENV && merged.HOSTILE_ENV !== 'development') {
    log.warn(`HOSTILE_ENV is "${merged.HOSTILE_ENV}" in .env; local setup expects "development".`);
  }
}

async function main() {
  console.log('\nHostile local setup\n');
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24)
    log.warn(`Node ${process.versions.node} detected; this project is tested with Node 24 LTS.`);

  await ensureEnvFile();
  const env = loadRepoEnv();

  const lk = findLivekitBinary(env);
  if (!lk || lk.missing) {
    log.warn('LiveKit server not found. Voice and screen sharing need it:');
    console.log('    macOS:    brew install livekit');
    console.log(
      '    Windows:  pnpm livekit:install   (downloads the official release into .tools/)',
    );
    console.log('    Linux:    pnpm livekit:install');
    console.log('    or set LIVEKIT_BIN in .env to an existing livekit-server executable.');
  } else {
    const note =
      lk.version && lk.version !== LIVEKIT_VERSION ? ` (tested with ${LIVEKIT_VERSION})` : '';
    log.ok(`LiveKit ${lk.version ?? '?'} from ${lk.source}: ${lk.path}${note}`);
  }

  let seed = args.has('--seed');
  if (!seed && !args.has('--no-seed') && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      '\nCreate DEVELOPMENT-ONLY test people (Alice, Bob) and channels? They are refused in production. [y/N] ',
    );
    rl.close();
    seed = /^y(es)?$/i.test(answer.trim());
  }
  if (seed) {
    const tsx = resolveBin('tsx', 'tsx', SERVER_DIR);
    const code = await runInherit(process.execPath, [tsx, 'src/cli/seed-dev.ts'], {
      cwd: SERVER_DIR,
    });
    if (code !== 0) process.exit(code);
  } else {
    log.info('Skipped development seed. Run `pnpm db:seed:dev` later.');
  }

  console.log(
    `\nNext:\n  pnpm dev                              # API, web client and LiveKit\n  open http://localhost:${env.WEB_PORT}\n  pnpm dev:desktop -- --profile=alice   # desktop client (after pnpm dev is running)\n`,
  );
}

main().catch((err) => {
  log.fail(err?.stack ?? String(err));
  process.exit(1);
});
