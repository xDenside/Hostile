import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ShortcutAction, ShortcutBindings } from '@hostile/shared';
import { log, messageOf } from './log.js';

const FILE_VERSION = 1;

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ['toggleMute', 'toggleDeafen'];

export interface DesktopSettings {
  serverUrl: string | null;
  shortcuts: ShortcutBindings;
  room: 'host' | 'guest' | null;
  hostOwner: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: WindowBounds | null;
  maximized: boolean;
}

export interface SettingsStore {
  get(): DesktopSettings;
  setShortcuts(bindings: ShortcutBindings): void;
  setRoom(room: DesktopSettings['room']): void;
  setHostOwner(exists: boolean): void;
  useHostedServer(url: string | null): void;
}

export interface WindowStateStore {
  get(): WindowState;
  set(state: WindowState): void;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`ignoring unreadable ${basename(file)}: ${messageOf(err)}`);
    }
    return null;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    log.warn(`could not write ${basename(file)}: ${messageOf(err)}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseShortcuts(value: unknown): ShortcutBindings {
  const bindings: ShortcutBindings = { toggleMute: null, toggleDeafen: null };
  if (!isRecord(value)) return bindings;
  for (const action of SHORTCUT_ACTIONS) {
    const raw = value[action];
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 80) bindings[action] = raw;
  }
  return bindings;
}

function parseSettings(value: unknown): DesktopSettings {
  if (!isRecord(value))
    return { serverUrl: null, shortcuts: parseShortcuts(null), room: null, hostOwner: false };
  return {
    serverUrl: null,
    shortcuts: parseShortcuts(value.shortcuts),
    room: value.room === 'host' || value.room === 'guest' ? value.room : null,
    hostOwner: value.hostOwner === true,
  };
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

function parseBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 200 || height < 200 || width > 20_000 || height > 20_000) return null;
  return { x, y, width, height };
}

export function createSettingsStore(userDataDir: string): SettingsStore {
  const file = join(userDataDir, 'settings.json');
  let current = parseSettings(readJsonFile(file));
  let hostedServer: string | null = null;

  const persist = () => writeJsonFile(file, { version: FILE_VERSION, ...current });

  return {
    get: () => ({
      ...current,
      serverUrl: hostedServer,
      shortcuts: { ...current.shortcuts },
    }),
    setShortcuts(bindings) {
      current = { ...current, shortcuts: { ...bindings } };
      persist();
    },
    setRoom(room) {
      current = { ...current, room };
      persist();
    },
    setHostOwner(exists) {
      current = { ...current, hostOwner: exists };
      persist();
    },
    useHostedServer(url) {
      hostedServer = url;
    },
  };
}

export function createWindowStateStore(userDataDir: string): WindowStateStore {
  const file = join(userDataDir, 'window-state.json');
  const raw = readJsonFile(file);
  let current: WindowState = {
    bounds: parseBounds(isRecord(raw) ? raw.bounds : null),
    maximized: isRecord(raw) && raw.maximized === true,
  };

  return {
    get: () => ({
      bounds: current.bounds ? { ...current.bounds } : null,
      maximized: current.maximized,
    }),
    set(state) {
      current = { bounds: state.bounds ? { ...state.bounds } : null, maximized: state.maximized };
      writeJsonFile(file, { version: FILE_VERSION, ...current });
    },
  };
}
