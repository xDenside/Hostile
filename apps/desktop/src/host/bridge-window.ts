import { join } from 'node:path';
import { BrowserWindow, ipcMain, session, type Session } from 'electron';
import { BRAND, DESKTOP_ORIGIN } from '@hostile/shared';
import { CHANNEL } from '../channels.js';
import { isSameOrigin } from '../origin.js';

export const BRIDGE_PARTITION = 'persist:hostile-bridge';

export interface BridgeReport {
  room: 'joining' | 'open' | 'failed';
  guests: number;
}

export function installBridgePermissions(bridge: Session): void {
  bridge.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  bridge.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (permission !== 'media' || details.mediaType === 'video') return false;
    return isSameOrigin(details.securityOrigin ?? origin, DESKTOP_ORIGIN);
  });
  bridge.setDisplayMediaRequestHandler((_request, callback) => {
    (callback as unknown as (streams: null) => void)(null);
  });
}

export function bridgeSession(): Session {
  return session.fromPartition(BRIDGE_PARTITION);
}

export interface BridgeConfigForPage {
  code: string;
  gatewayUrl: string;
  gatewaySecret: string;
}

export function openBridgeWindow(
  config: BridgeConfigForPage,
  onReport: (report: BridgeReport) => void,
  onGone: (reason: string) => void,
): { window: BrowserWindow; close(): void } {
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    webPreferences: {
      partition: BRIDGE_PARTITION,
      preload: join(__dirname, 'bridge-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  window.webContents.setWebRTCIPHandlingPolicy('default');
  const listener = (event: Electron.IpcMainEvent, report: unknown) => {
    if (event.sender !== window.webContents) return;
    const r = report as Partial<BridgeReport> | null;
    if (r?.room !== 'joining' && r?.room !== 'open' && r?.room !== 'failed') return;
    onReport({ room: r.room, guests: Number(r.guests) || 0 });
  };
  ipcMain.on(CHANNEL.bridgeReport, listener);
  let closing = false;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!closing) onGone(details.reason);
  });
  window.on('closed', () => {
    ipcMain.removeListener(CHANNEL.bridgeReport, listener);
    if (!closing) onGone('closed');
  });
  const fragment = Buffer.from(JSON.stringify(config)).toString('base64');
  void window.loadURL(`${BRAND.desktopScheme}://${BRAND.desktopHost}/bridge.html#${fragment}`);
  return {
    window,
    close() {
      closing = true;
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
