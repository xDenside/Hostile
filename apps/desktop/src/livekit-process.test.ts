import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';

mock.module('electron', { namedExports: { app: { isPackaged: false } } });

const { reapLeftoverLivekit, startLivekit } = await import('./host/livekit-process.js');

const INPUTS = { port: 11, udpPort: 22, key: 'k', secret: 's'.repeat(32), apiPort: 33 };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`after ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function start(dir: string, name = 'stubborn-server') {
  const program = join(dir, name);
  const ready = join(dir, 'ready');
  rmSync(ready, { force: true });
  writeFileSync(program, `#!/bin/sh\ntrap '' TERM\n: > "${ready}"\nwhile :; do sleep 0.2; done\n`);
  chmodSync(program, 0o755);
  return startLivekit(program, dir, INPUTS);
}

async function serverPid(dir: string) {
  const file = join(dir, 'livekit.pid');
  await until(() => existsSync(file) && existsSync(join(dir, 'ready')), 5_000, 'no server yet');
  return Number(readFileSync(file, 'utf8').trim());
}

describe(
  'the media server under its watching shell',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostile-livekit-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('ends a server that will not leave by itself once it is asked to stop', async () => {
      const media = start(dir);
      const pid = await serverPid(dir);
      assert.equal(alive(pid), true);
      media.stop();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(alive(pid), true);
      await until(() => !alive(pid), 6_000, 'the server is still running');
      await until(() => media.child.exitCode !== null, 2_000, 'the shell is still running');
      assert.equal(existsSync(join(dir, 'livekit.pid')), false);
    });

    it('kills the server itself, and not only the shell watching it', async () => {
      const media = start(dir);
      const pid = await serverPid(dir);
      media.kill();
      await until(() => !alive(pid), 2_000, 'the server outlived the kill');
      await until(() => !existsSync(join(dir, 'livekit.pid')), 2_000, 'the note of the pid stayed');
    });

    it('takes the server with it if something else kills the shell', async () => {
      const media = start(dir);
      const pid = await serverPid(dir);
      media.child.kill('SIGKILL');
      await until(() => !alive(pid), 2_000, 'the server was left behind');
      await until(() => !existsSync(join(dir, 'livekit.pid')), 2_000, 'the note of the pid stayed');
    });

    it('finds a server left behind in a folder whose name is not ASCII, and only its own', async () => {
      const locale = process.env.LC_ALL;
      process.env.LC_ALL = 'C';
      const odd = mkdtempSync(join(tmpdir(), 'hostile-хост профиль-'));
      const other = mkdtempSync(join(tmpdir(), 'hostile-другой-'));
      const running: ReturnType<typeof start>[] = [];
      try {
        running.push(start(odd, 'livekit-server'));
        const pid = await serverPid(odd);
        running.push(start(other, 'livekit-server'));
        const theirPid = await serverPid(other);
        writeFileSync(join(odd, 'livekit.pid'), String(theirPid));
        reapLeftoverLivekit(odd);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(alive(theirPid), true);
        writeFileSync(join(odd, 'livekit.pid'), String(pid));
        reapLeftoverLivekit(odd);
        await until(() => !alive(pid), 2_000, 'the server left behind is still running');
      } finally {
        for (const media of running) media.kill();
        if (locale === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = locale;
        rmSync(odd, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
      }
    });
  },
);
