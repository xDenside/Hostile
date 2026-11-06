import { join } from 'node:path';
import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import { safeExternalUrl } from '@hostile/shared';
import { log } from './log.js';
import { isSameOrigin } from './origin.js';
import type { RendererTarget, Runtime } from './runtime.js';
import type { WindowBounds } from './store.js';

const MIN_WIDTH = 940;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1240;
const DEFAULT_HEIGHT = 820;
const SAVE_DEBOUNCE_MS = 500;

const INTERNAL_SCHEMES = ['devtools:', 'chrome-extension:'];

export function createMainWindow(runtime: Runtime): BrowserWindow {
  const saved = runtime.windowState.get();
  const bounds = usableBounds(saved.bounds);

  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#171a20',
    title: 'Hostile',
    autoHideMenuBar: process.platform !== 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  if (saved.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());

  installWindowStatePersistence(window, runtime);

  return window;
}

function usableBounds(
  saved: WindowBounds | null,
): WindowBounds | { width: number; height: number } {
  if (!saved) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const width = Math.max(MIN_WIDTH, saved.width);
  const height = Math.max(MIN_HEIGHT, saved.height);
  const candidate = { x: saved.x, y: saved.y, width, height };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX =
      Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x);
    const overlapY =
      Math.min(candidate.y + candidate.height, area.y + area.height) -
      Math.max(candidate.y, area.y);
    return overlapX >= 200 && overlapY >= 80;
  });
  if (!visible) {
    log.info('saved window position is off-screen; opening with the default size');
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  return candidate;
}

function installWindowStatePersistence(window: BrowserWindow, runtime: Runtime): void {
  let timer: NodeJS.Timeout | null = null;

  const capture = () => {
    if (window.isDestroyed()) return;
    runtime.windowState.set({ bounds: window.getNormalBounds(), maximized: window.isMaximized() });
  };

  const scheduleCapture = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(capture, SAVE_DEBOUNCE_MS);
  };

  window.on('resize', scheduleCapture);
  window.on('move', scheduleCapture);
  window.on('maximize', scheduleCapture);
  window.on('unmaximize', scheduleCapture);
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    capture();
  });
}

export function installNavigationGuards(contents: WebContents, target: RendererTarget): void {
  const allowed = (url: string) => isAllowedNavigation(url, target);

  contents.on('will-navigate', (details) => {
    if (allowed(details.url)) return;
    details.preventDefault();
    log.warn(`blocked navigation to ${details.url}`);
    openExternally(details.url);
  });

  contents.on('will-frame-navigate', (details) => {
    if (allowed(details.url)) return;
    details.preventDefault();
    log.warn(`blocked frame navigation to ${details.url}`);
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('blocked a <webview> attachment');
  });
}

function isAllowedNavigation(url: string, target: RendererTarget): boolean {
  if (INTERNAL_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  if (url === 'about:blank') return false;
  return isSameOrigin(url, target.origin);
}

export function openExternally(url: string): boolean {
  const safe = safeExternalUrl(url);
  if (!safe) {
    log.warn(`refused to open a link that is not a plain http(s) URL: ${url.slice(0, 120)}`);
    return false;
  }
  void shell.openExternal(safe);
  return true;
}
