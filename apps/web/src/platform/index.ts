import {
  DESKTOP_BRIDGE_GLOBAL,
  type DesktopBridge,
  type RoomState,
  type SelfUser,
} from '@hostile/shared';
import { becomeGuestInApp } from '../tunnel/net';
import { createDesktopPlatform } from './desktop';
import { createWebPlatform } from './web';

export interface Platform {
  kind: 'web' | 'desktop';
  apiBase(): string;
  socketUrl(): string | undefined;
  authHeaders(method: string): Record<string, string>;
  socketAuth(): Record<string, string>;
  recoverFromUnauthorized(): Promise<boolean>;
  adoptSession(csrfToken: string): void;
  restoreSession(): Promise<SelfUser | null>;
  logout(): Promise<{ serverConfirmed: boolean }>;
  dropCredentials(): void;
  openExternal(url: string): void;
  desktop: DesktopBridge | null;
}

declare global {
  interface Window {
    [DESKTOP_BRIDGE_GLOBAL]?: DesktopBridge;
  }
}

let current: Platform | null = null;
let room: RoomState | null = null;

export const desktopRoom = () => room;

export async function initPlatform(): Promise<Platform> {
  const bridge = window[DESKTOP_BRIDGE_GLOBAL];
  if (bridge) {
    room = await bridge.room.get();
    if (room.role === 'guest') {
      becomeGuestInApp();
      current = {
        ...createWebPlatform(),
        kind: 'desktop',
        desktop: bridge,
        openExternal: (url) => void bridge.openExternal(url).catch(() => undefined),
      };
    } else {
      current = createDesktopPlatform(bridge, room.serverUrl);
    }
  } else {
    current = createWebPlatform();
  }
  return current;
}

export function platform(): Platform {
  if (!current) throw new Error('initPlatform() has not completed');
  return current;
}
