import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { log, messageOf } from '../log.js';
import { renderLivekitConfig, type LivekitConfigInputs } from './livekit-config.js';

const EXE = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';

export function findLivekitProgram(): string | null {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'bin', EXE);
    return existsSync(bundled) ? bundled : null;
  }
  const repoRoot = resolve(__dirname, '../../..');
  const candidates = [
    '/opt/homebrew/opt/livekit/bin/livekit-server',
    join(repoRoot, '.tools', 'livekit', '1.13.7', EXE),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const WATCHED_START =
  'exec 3<&0; "$0" --config "$1" </dev/null & p=$!; printf "%s\\n" "$p"; ' +
  '( read -r _ <&3; kill "$p" 2>/dev/null; sleep 3 </dev/null >/dev/null 2>&1; kill -9 "$p" 2>/dev/null ) & ' +
  'w=$!; wait "$p"; c=$?; kill "$w" 2>/dev/null; exit $c';

export interface LivekitProcess {
  child: ChildProcess;
  stop(): void;
  kill(): void;
}

function pidFile(hostDir: string) {
  return join(hostDir, 'livekit.pid');
}

export function reapLeftoverLivekit(hostDir: string): void {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(hostDir), 'utf8').trim());
  } catch {
    return;
  }
  rmSync(pidFile(hostDir), { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const command =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
          })
        : execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const ours =
      process.platform === 'win32'
        ? command.toLowerCase().includes('livekit-server')
        : command.includes('livekit-server') &&
          (command.includes(configName(hostDir)) || command.includes(oldConfigFile(hostDir)));
    if (!ours) return;
    process.kill(pid, 'SIGKILL');
    log.warn('stopped a media server left behind by an earlier run');
  } catch {}
}

const configName = (hostDir: string) =>
  `livekit-${createHash('sha256').update(hostDir).digest('hex').slice(0, 16)}.yaml`;
const configFile = (hostDir: string) => join(hostDir, configName(hostDir));
const oldConfigFile = (hostDir: string) => join(hostDir, 'livekit.yaml');

export function startLivekit(
  program: string,
  hostDir: string,
  inputs: LivekitConfigInputs,
): LivekitProcess {
  const config = configFile(hostDir);
  rmSync(oldConfigFile(hostDir), { force: true });
  writeFileSync(config, renderLivekitConfig(inputs), { mode: 0o600 });
  chmodSync(config, 0o600);

  const output = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) log.warn(`media server: ${line.slice(0, 500)}`);
    }
  };

  if (process.platform === 'win32') {
    const child = spawn(program, ['--config', config], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.pid) writeFileSync(pidFile(hostDir), String(child.pid), { mode: 0o600 });
    child.once('exit', () => rmSync(pidFile(hostDir), { force: true }));
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    return { child, stop: () => child.kill(), kill: () => child.kill() };
  }

  const child = spawn('/bin/sh', ['-c', WATCHED_START, program, config], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => undefined);
  let first = '';
  let told = false;
  let serverPid: number | null = null;
  const killServer = () => {
    try {
      if (serverPid) process.kill(serverPid, 'SIGKILL');
    } catch {}
  };
  child.once('exit', (_code, signal) => {
    if (signal) killServer();
    rmSync(pidFile(hostDir), { force: true });
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (told) return output(chunk);
    first += chunk.toString('utf8');
    const end = first.indexOf('\n');
    if (end < 0) return;
    told = true;
    serverPid = Number(first.slice(0, end)) || null;
    try {
      writeFileSync(pidFile(hostDir), first.slice(0, end), { mode: 0o600 });
    } catch (err) {
      log.warn(`could not note the media server's pid: ${messageOf(err)}`);
    }
    if (first.length > end + 1) output(Buffer.from(first.slice(end + 1)));
  });
  child.stderr.on('data', output);
  return {
    child,
    stop: () => child.stdin.end(),
    kill: () => {
      killServer();
      child.kill('SIGKILL');
    },
  };
}
