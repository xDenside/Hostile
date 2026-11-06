import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const child = spawn(
  process.execPath,
  [join(repoRoot, 'scripts', 'package-desktop.mjs'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: repoRoot,
  },
);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
