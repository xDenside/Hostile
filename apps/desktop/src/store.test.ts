import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { log } from './log.js';
import { createSettingsStore } from './store.js';

let dir: string;

const writeSettings = (settings: unknown): void =>
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hostile-settings-'));
  mock.method(log, 'warn', () => undefined);
});

afterEach(() => {
  mock.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe('settings store', () => {
  it('starts empty and persists what it is given', () => {
    const store = createSettingsStore(dir);
    assert.deepEqual(store.get(), {
      serverUrl: null,
      shortcuts: { toggleMute: null, toggleDeafen: null },
      room: null,
      hostOwner: false,
    });

    store.setRoom('guest');
    store.setShortcuts({ toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: null });
    assert.deepEqual(createSettingsStore(dir).get(), {
      serverUrl: null,
      shortcuts: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: null },
      room: 'guest',
      hostOwner: false,
    });
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      version: number;
    };
    assert.equal(raw.version, 1);
  });

  it('has no stored server address: one left in a file points the app nowhere', () => {
    writeSettings({ version: 1, serverUrl: 'https://chat.example.com' });
    const store = createSettingsStore(dir);
    assert.equal(store.get().serverUrl, null);
    store.useHostedServer('http://127.0.0.1:4191');
    assert.equal(store.get().serverUrl, 'http://127.0.0.1:4191');
    store.setRoom('host');
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      serverUrl?: unknown;
    };
    assert.equal(raw.serverUrl, null, 'the address of this run is not written down');
  });

  it('ignores a settings file that is not usable at all', () => {
    writeFileSync(join(dir, 'settings.json'), 'nonsense');
    assert.equal(createSettingsStore(dir).get().serverUrl, null);

    writeSettings({ version: 1, serverUrl: 42, shortcuts: { toggleMute: 7 } });
    assert.deepEqual(createSettingsStore(dir).get(), {
      serverUrl: null,
      shortcuts: { toggleMute: null, toggleDeafen: null },
      room: null,
      hostOwner: false,
    });
  });
});
