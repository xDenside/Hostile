import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/env.mjs';
import { log } from './lib/proc.mjs';
import { findSecrets, forbiddenPath } from './lib/secret-scan.mjs';

const SKIP_FILE = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|wav|webm|wasm|icns)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean);

const problems = [];
let scanned = 0;

for (const file of files) {
  const kind = forbiddenPath(file);
  if (kind) problems.push(`${file}: ${kind}`);
  if (SKIP_FILE.test(file)) continue;
  const path = join(REPO_ROOT, file);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;
  scanned += 1;
  for (const found of findSecrets(readFileSync(path, 'utf8'))) {
    problems.push(`${file}:${found.line}: ${found.kind}`);
  }
}

if (problems.length) {
  log.fail(`${problems.length} possible secret(s) in the repository:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nIf one is real, committing it was the leak: change the secret itself as well as the file.',
  );
  process.exit(1);
}
log.ok(`No secrets in ${scanned} files (${files.length} paths checked).`);
