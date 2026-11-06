import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unpackagedDockIcon } from './platform.js';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the Dock icon of an unpackaged run is found from where the bundled main process sits', () => {
  const icon = unpackagedDockIcon(join(desktopDir, 'dist'));
  assert.equal(icon, join(desktopDir, 'build', 'icon-mac.png'));
  const png = readFileSync(icon);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
});

test('a missing Dock icon is no icon, not an error', () => {
  assert.equal(unpackagedDockIcon(join(tmpdir(), 'no-such-hostile-folder', 'dist')), null);
});
