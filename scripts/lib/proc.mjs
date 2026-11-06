import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { REPO_ROOT } from './env.mjs';

const COLORS = [36, 35, 33, 32, 34, 91, 96];
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function color(code, text) {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const log = {
  info: (msg) => console.log(`${color(36, '›')} ${msg}`),
  ok: (msg) => console.log(`${color(32, '✔')} ${msg}`),
  warn: (msg) => console.log(`${color(33, '!')} ${msg}`),
  fail: (msg) => console.log(`${color(31, '✘')} ${msg}`),
};

export function resolveBin(pkg, bin, fromDir = REPO_ROOT) {
  const require = createRequire(join(fromDir, 'package.json'));
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const rel = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin[bin ?? pkg];
  return join(dirname(pkgJsonPath), rel);
}

export function which(cmd) {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = join(dir, cmd + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

export function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...opts });
  return {
    code: res.status ?? (res.error ? -1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
}

export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
    child.on('error', (err) => {
      log.fail(`${cmd}: ${err.message}`);
      resolvePromise(1);
    });
    child.on('exit', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

let colorIndex = 0;

export function startService(name, cmd, args, opts = {}) {
  const tint = COLORS[colorIndex++ % COLORS.length];
  const prefix = color(tint, `[${name}]`.padEnd(11));
  const { env: extraEnv, ...spawnOpts } = opts;
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spawnOpts,
    env: { ...process.env, FORCE_COLOR: useColor ? '1' : '0', ...(extraEnv ?? {}) },
  });
  const pipe = (stream, target) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix} ${line}\n`);
    });
    stream.on('end', () => buf && target.write(`${prefix} ${buf}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  let exited = false;
  const exitPromise = new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolvePromise({ code, signal });
    });
    child.on('error', (err) => {
      exited = true;
      process.stderr.write(`${prefix} failed to start: ${err.message}\n`);
      resolvePromise({ code: 1, signal: null, error: err });
    });
  });

  return {
    name,
    child,
    exited: exitPromise,
    get running() {
      return !exited;
    },
    async stop(timeoutMs = 8000) {
      if (exited) return;
      child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
      const timer = setTimeout(() => {
        if (!exited) {
          process.stderr.write(`${prefix} did not stop within ${timeoutMs} ms, killing\n`);
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      await exitPromise;
      clearTimeout(timer);
    },
  };
}
