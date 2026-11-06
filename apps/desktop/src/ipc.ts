import { ipcMain, app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  LIMITS,
  type DesktopInfo,
  type HostingStatus,
  type HostOwnerProfile,
  type RoomState,
  type ShortcutBindings,
  type ShortcutState,
} from '@hostile/shared';
import type { AuthService } from './auth.js';
import type { CaptureService } from './capture.js';
import { CHANNEL } from './channels.js';
import { log } from './log.js';
import { mediaAccessStatus, openPrivacySettings, requestMicrophoneAccess } from './media-access.js';
import { isSameOrigin } from './origin.js';
import { platformName, systemVersion } from './platform.js';
import type { Runtime } from './runtime.js';
import { openExternally } from './window.js';

export interface BridgeDeps {
  runtime: Runtime;
  auth: AuthService;
  capture: CaptureService;
  mainWindow: () => BrowserWindow | null;
  room: {
    get(): Promise<RoomState>;
    host(owner: HostOwnerProfile | null): Promise<{ ok: true } | { ok: false; error: string }>;
    join(): void;
    leave(): Promise<void>;
    status(): HostingStatus;
    newCode(): Promise<HostingStatus>;
  };
  shortcuts: {
    current(): ShortcutState;
    update(bindings: ShortcutBindings): ShortcutState;
  };
}

const REJECTED = 'This request did not come from the Hostile window.';
const INVALID = 'The request was not understood.';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

function asPicture(value: unknown, max: number): ArrayBuffer | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof ArrayBuffer) || value.byteLength > max) throw new Error(INVALID);
  return value;
}

function isTrustedSender(deps: BridgeDeps, event: IpcMainInvokeEvent): boolean {
  const window = deps.mainWindow();
  if (!window || window.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame.isDestroyed() || frame.parent !== null) return false;
  try {
    return (
      isSameOrigin(frame.origin, deps.runtime.target.origin) ||
      isSameOrigin(frame.url, deps.runtime.target.origin)
    );
  } catch {
    return false;
  }
}

function handle(
  deps: BridgeDeps,
  channel: string,
  handler: (args: unknown[]) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedSender(deps, event)) {
      log.warn(`rejected ${channel}: untrusted sender`);
      throw new Error(REJECTED);
    }
    return handler(args);
  });
}

function info(runtime: Runtime): DesktopInfo {
  return {
    platform: platformName(),
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    osVersion: systemVersion(),
    profile: runtime.profile,
    isPackaged: app.isPackaged,
  };
}

export function registerBridgeHandlers(deps: BridgeDeps): void {
  const { runtime, auth, capture } = deps;

  handle(deps, CHANNEL.info, () => info(runtime));

  handle(deps, CHANNEL.roomGet, () => deps.room.get());

  handle(deps, CHANNEL.roomHost, (args) => {
    if (args[0] === null || args[0] === undefined) return deps.room.host(null);
    const body = asRecord(args[0]);
    const displayName = body && asString(body.displayName, LIMITS.displayNameMax);
    if (!displayName) throw new Error(INVALID);
    const avatar = asPicture(body.avatar, LIMITS.avatarMaxBytes);
    const banner = asPicture(body.banner, LIMITS.bannerMaxBytes);
    return deps.room.host({
      displayName,
      ...(avatar ? { avatar } : {}),
      ...(banner ? { banner } : {}),
    });
  });

  handle(deps, CHANNEL.roomJoin, () => deps.room.join());

  handle(deps, CHANNEL.roomLeave, () => deps.room.leave());

  handle(deps, CHANNEL.hostingStatus, () => deps.room.status());

  handle(deps, CHANNEL.hostingNewCode, () => deps.room.newCode());

  handle(deps, CHANNEL.authRefresh, () => auth.refresh());

  handle(deps, CHANNEL.authLogout, () => auth.logout());

  handle(deps, CHANNEL.captureList, () => capture.listSources());

  handle(deps, CHANNEL.captureSelect, (args) => {
    const body = asRecord(args[0]);
    const sourceId = body && asString(body.sourceId, 512);
    if (!sourceId || typeof body?.audio !== 'boolean') return { ok: false, error: INVALID };
    return capture.selectSource({ sourceId, audio: body.audio });
  });

  handle(deps, CHANNEL.captureCapabilities, () => capture.capabilities());

  handle(deps, CHANNEL.mediaStatus, () => mediaAccessStatus());

  handle(deps, CHANNEL.mediaRequestMicrophone, () => requestMicrophoneAccess());

  handle(deps, CHANNEL.mediaOpenPrivacySettings, async (args) => {
    const kind = args[0];
    if (kind !== 'microphone' && kind !== 'screen') throw new Error(INVALID);
    await openPrivacySettings(kind);
  });

  handle(deps, CHANNEL.shortcutsGet, () => deps.shortcuts.current());

  handle(deps, CHANNEL.shortcutsSet, (args) => {
    const body = asRecord(args[0]);
    if (!body) throw new Error(INVALID);
    const bindings: ShortcutBindings = { toggleMute: null, toggleDeafen: null };
    for (const action of ['toggleMute', 'toggleDeafen'] as const) {
      const value = body[action];
      if (value === null || value === undefined) continue;
      const accelerator = asString(value, 80);
      if (!accelerator) throw new Error(INVALID);
      bindings[action] = accelerator;
    }
    return deps.shortcuts.update(bindings);
  });

  handle(deps, CHANNEL.openExternal, (args) => {
    const url = asString(args[0], 2048);
    if (!url) throw new Error(INVALID);
    if (!openExternally(url)) throw new Error('Only http:// and https:// links can be opened.');
  });
}
