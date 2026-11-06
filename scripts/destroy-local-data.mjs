import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { ENV_FILE, LOCAL_DIR, readEnvFile, loadRepoEnv } from './lib/env.mjs';
import { color, log } from './lib/proc.mjs';

const args = new Set(process.argv.slice(2));

async function confirm() {
  if (args.has('--yes-i-am-sure')) {
    log.warn('--yes-i-am-sure given: proceeding without asking.');
    return true;
  }
  if (!process.stdin.isTTY) {
    log.fail('Refusing to destroy data without confirmation.');
    log.info('This command needs an interactive terminal, or the explicit flag --yes-i-am-sure.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nType ${color(1, 'DESTROY')} to delete the data, or anything else to abort: `,
  );
  rl.close();
  if (answer.trim() !== 'DESTROY') {
    log.ok('Aborted. Nothing was changed.');
    return false;
  }
  return true;
}

function folderIsOpen(lockFile) {
  if (!existsSync(lockFile)) return false;
  try {
    process.kill(JSON.parse(readFileSync(lockFile, 'utf8')).pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function main() {
  console.log(`\n${color(1, 'Destroy local Hostile data')}\n`);

  if (!existsSync(ENV_FILE)) {
    log.fail(
      `.env not found at ${ENV_FILE}. There is no local data to destroy; run \`pnpm setup:local\`.`,
    );
    process.exit(1);
  }
  const env = loadRepoEnv();
  if (env.HOSTILE_ENV !== 'development') {
    log.fail(
      `HOSTILE_ENV=${env.HOSTILE_ENV ?? '(unset)'} - this command only runs against a development setup.`,
    );
    process.exit(1);
  }

  const dataDir = resolve(readEnvFile()?.DATA_DIR || join(LOCAL_DIR, 'data'));
  if (!existsSync(dataDir)) {
    log.ok(`Nothing to destroy: ${dataDir} does not exist.`);
    return;
  }
  if (folderIsOpen(join(dataDir, 'db.lock'))) {
    log.fail(`${dataDir} is open: the development API is still running.`);
    log.info('Stop `pnpm dev` with Ctrl+C, then run this command again.');
    process.exit(1);
  }

  console.log('This will permanently delete:');
  console.log(`  - ${color(1, dataDir)}: every local person, message, session and file`);
  console.log('\nIt will NOT touch:');
  console.log('  - your .env file or its generated development secrets');
  console.log('  - anything in git');
  console.log('\nThe next start makes an empty, fully migrated database with no users at all.');

  if (!(await confirm())) process.exit(1);

  rmSync(dataDir, { recursive: true, force: true });
  log.ok(`Deleted ${dataDir}`);

  console.log(`
${color(1, 'Next')} - there are no accounts now, so create one:
  pnpm db:seed:dev                      development-only test users (alice, bob) and channels
  pnpm dev                              start the stack afterwards
`);
}

main().catch((err) => {
  log.fail(err?.stack ?? String(err));
  process.exit(1);
});
