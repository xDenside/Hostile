import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ENV_EXAMPLE, REPO_ROOT } from './env.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hostile-env-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const SERVER_NAME = /^COMMUNITY_NAME=Hostile$/m;

describe('the name of the server in a new local .env', () => {
  it('is Hostile in the template', () => {
    assert.match(readFileSync(ENV_EXAMPLE, 'utf8'), SERVER_NAME);
  });

  it('is what pnpm setup:local writes', () => {
    const file = join(dir, 'fresh.env');
    const result = spawnSync(process.execPath, ['scripts/setup-local.mjs', '--no-seed'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOSTILE_ENV_FILE: file, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(file, 'utf8'), SERVER_NAME);
  });
});
