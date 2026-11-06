import type { ApiErrorBody } from './errors.js';
import type { SelfUser } from './dto.js';

export interface DesktopBridge {
  readonly bridgeVersion: 1;
  getInfo(): Promise<DesktopInfo>;

  room: {
    get(): Promise<RoomState>;
    host(owner?: HostOwnerProfile): Promise<{ ok: true } | { ok: false; error: string }>;
    join(): Promise<void>;
    leave(): Promise<void>;
  };

  hosting: {
    status(): Promise<HostingStatus>;
    newCode(): Promise<HostingStatus>;
    onStatus(listener: (status: HostingStatus) => void): () => void;
  };

  auth: {
    refresh(): Promise<DesktopAuthResult>;
    logout(): Promise<{ serverConfirmed: boolean }>;
  };

  capture: {
    listSources(): Promise<CaptureSource[]>;
    selectSource(req: {
      sourceId: string;
      audio: boolean;
    }): Promise<{ ok: true } | { ok: false; error: string }>;
    getCapabilities(): Promise<CaptureCapabilities>;
  };

  media: {
    getAccessStatus(): Promise<MediaAccessStatus>;
    requestMicrophoneAccess(): Promise<boolean>;
    openPrivacySettings(kind: 'microphone' | 'screen'): Promise<void>;
  };

  shortcuts: {
    get(): Promise<ShortcutState>;
    set(bindings: ShortcutBindings): Promise<ShortcutState>;
    onTriggered(listener: (action: ShortcutAction) => void): () => void;
  };

  onPowerEvent(listener: (event: PowerEvent) => void): () => void;

  openExternal(url: string): Promise<void>;
}

export interface HostOwnerProfile {
  displayName: string;
  avatar?: ArrayBuffer;
  banner?: ArrayBuffer;
}

export interface RoomState {
  role: 'none' | 'host' | 'guest';
  serverUrl: string | null;
  ownerExists: boolean;
  hostError: string | null;
  justCreated: boolean;
}

export interface HostingPart {
  state: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
  restarts?: number;
  detail?: string;
}

export interface HostingStatus {
  active: boolean;
  code: string | null;
  guests: number;
  awake: boolean;
  parts: {
    server: HostingPart;
    gateway: HostingPart;
    media: HostingPart;
    bridge: HostingPart;
  };
}

export type DesktopAuthResult =
  | { ok: true; user: SelfUser; accessToken: string; accessTokenExpiresAt: string }
  | { ok: false; status: number; error: ApiErrorBody['error'] };

export interface DesktopInfo {
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  osVersion: string;
  profile: string;
  isPackaged: boolean;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface CaptureCapabilities {
  systemAudio: 'supported' | 'unsupported';
  systemAudioNote: string;
  screenPermission: MediaPermissionState;
}

export type MediaPermissionState =
  'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface MediaAccessStatus {
  microphone: MediaPermissionState;
  screen: MediaPermissionState;
}

export type ShortcutAction = 'toggleMute' | 'toggleDeafen';

export type ShortcutBindings = Record<ShortcutAction, string | null>;

export type ShortcutRegistration = 'registered' | 'conflict' | 'invalid' | 'unset';

export interface ShortcutState {
  bindings: ShortcutBindings;
  status: Record<ShortcutAction, ShortcutRegistration>;
}

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export const DESKTOP_BRIDGE_GLOBAL = 'hostileDesktop' as const;
