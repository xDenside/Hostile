import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CaptureCapabilities,
  CaptureSource,
  DESKTOP_BRIDGE_GLOBAL,
  DesktopAuthResult,
  DesktopBridge,
  DesktopInfo,
  HostingStatus,
  MediaAccessStatus,
  PowerEvent,
  RoomState,
  ShortcutAction,
  ShortcutBindings,
  ShortcutState,
} from '@hostile/shared';
import { CHANNEL, EVENT } from './channels.js';
import { plainIpcError } from './ipc-error.js';

const GLOBAL_NAME: typeof DESKTOP_BRIDGE_GLOBAL = 'hostileDesktop';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  (ipcRenderer.invoke(channel, ...args) as Promise<T>).catch((err: unknown) => {
    throw plainIpcError(err);
  });

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: DesktopBridge = {
  bridgeVersion: 1,
  getInfo: () => invoke<DesktopInfo>(CHANNEL.info),

  room: {
    get: () => invoke<RoomState>(CHANNEL.roomGet),
    host: (owner) =>
      invoke<{ ok: true } | { ok: false; error: string }>(CHANNEL.roomHost, owner ?? null),
    join: () => invoke<void>(CHANNEL.roomJoin),
    leave: () => invoke<void>(CHANNEL.roomLeave),
  },

  hosting: {
    status: () => invoke<HostingStatus>(CHANNEL.hostingStatus),
    newCode: () => invoke<HostingStatus>(CHANNEL.hostingNewCode),
    onStatus: (listener) => subscribe<HostingStatus>(EVENT.hostingStatus, listener),
  },

  auth: {
    refresh: () => invoke<DesktopAuthResult>(CHANNEL.authRefresh),
    logout: () => invoke<{ serverConfirmed: boolean }>(CHANNEL.authLogout),
  },

  capture: {
    listSources: () => invoke<CaptureSource[]>(CHANNEL.captureList),
    selectSource: (req) =>
      invoke<{ ok: true } | { ok: false; error: string }>(CHANNEL.captureSelect, req),
    getCapabilities: () => invoke<CaptureCapabilities>(CHANNEL.captureCapabilities),
  },

  media: {
    getAccessStatus: () => invoke<MediaAccessStatus>(CHANNEL.mediaStatus),
    requestMicrophoneAccess: () => invoke<boolean>(CHANNEL.mediaRequestMicrophone),
    openPrivacySettings: (kind) => invoke<void>(CHANNEL.mediaOpenPrivacySettings, kind),
  },

  shortcuts: {
    get: () => invoke<ShortcutState>(CHANNEL.shortcutsGet),
    set: (bindings: ShortcutBindings) => invoke<ShortcutState>(CHANNEL.shortcutsSet, bindings),
    onTriggered: (listener: (action: ShortcutAction) => void) =>
      subscribe<ShortcutAction>(EVENT.shortcutTriggered, listener),
  },

  onPowerEvent: (listener: (event: PowerEvent) => void) =>
    subscribe<PowerEvent>(EVENT.power, listener),

  openExternal: (url: string) => invoke<void>(CHANNEL.openExternal, url),
};

contextBridge.exposeInMainWorld(GLOBAL_NAME, bridge);
