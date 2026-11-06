import {
  app,
  dialog,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  type BrowserWindow,
} from 'electron';
import {
  type HostOwnerProfile,
  type ShortcutAction,
  type ShortcutBindings,
  type HostingStatus,
  type RoomState,
  type ShortcutState,
} from '@hostile/shared';
import { createAuthService, type AuthService } from './auth.js';
import { createCaptureService, type CaptureService } from './capture.js';
import { EVENT } from './channels.js';
import { bridgeSession } from './host/bridge-window.js';
import { noteEachAsking, type NoteWords } from './host/notify.js';
import { createHostService, type HostService } from './host/service.js';
import { registerBridgeHandlers } from './ipc.js';
import { loadFailure, log, messageOf } from './log.js';
import { unpackagedDockIcon } from './platform.js';
import { isProofBuild } from './proof.js';
import { applyProfile, readProfileArg } from './profile.js';
import {
  registerAppProtocol,
  registerAppSchemePrivileges,
  registerBridgeProtocol,
} from './protocol.js';
import {
  createRuntime,
  resolveRendererTarget,
  testRelays,
  type RendererTarget,
  type Runtime,
} from './runtime.js';
import {
  installDevelopmentCsp,
  installDisplayMediaHandler,
  installPermissionHandlers,
} from './session-guards.js';
import { applyShortcuts, releaseShortcuts } from './shortcuts.js';
import { createSettingsStore } from './store.js';
import { createMainWindow, installNavigationGuards } from './window.js';

const EMPTY_SHORTCUTS: ShortcutState = {
  bindings: { toggleMute: null, toggleDeafen: null },
  status: { toggleMute: 'unset', toggleDeafen: 'unset' },
};

let runtime: Runtime | null = null;
let auth: AuthService | null = null;
let capture: CaptureService | null = null;
let mainWindow: BrowserWindow | null = null;
let shortcutState: ShortcutState = EMPTY_SHORTCUTS;
let host: HostService | null = null;
let hostStarting: Promise<void> | null = null;
let hostError: string | null = null;
let justCreated = false;
let quitting = false;
let closeAnswered = false;
let startedAsGuest = false;

function send(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function updateShortcuts(bindings: ShortcutBindings): ShortcutState {
  shortcutState = applyShortcuts(bindings, (action: ShortcutAction) =>
    send(EVENT.shortcutTriggered, action),
  );
  runtime?.settings.setShortcuts(shortcutState.bindings);
  return shortcutState;
}

function broadcastHosting(status: HostingStatus) {
  send(EVENT.hostingStatus, status);
}

function reloadWindow() {
  setImmediate(() => {
    capture?.forget();
    if (runtime && mainWindow && !mainWindow.isDestroyed())
      void mainWindow.loadURL(runtime.target.url);
  });
}

async function prepareHosting(current: Runtime) {
  const ports = await host!.prepare();
  current.settings.useHostedServer(`http://127.0.0.1:${ports.api}`);
  current.livekitUrl = `ws://127.0.0.1:${ports.livekit}`;
}

function startHosting(current: Runtime): Promise<void> {
  hostError = null;
  hostStarting ??= host!
    .start()
    .then(() => current.settings.setHostOwner(host!.hasOwner()))
    .catch((err: unknown) => {
      log.error(`hosting could not start: ${String(err)}`);
      hostError =
        'The room could not start. Its data folder may be damaged, or something may be holding it. Nothing was deleted.';
    })
    .finally(() => {
      hostStarting = null;
    });
  return hostStarting;
}

async function roomState(current: Runtime): Promise<RoomState> {
  if (current.settings.get().room === 'host') await hostStarting;
  const { room, serverUrl, hostOwner } = current.settings.get();
  const created = justCreated;
  justCreated = false;
  return {
    role: room ?? 'none',
    serverUrl: room === 'host' ? serverUrl : null,
    ownerExists: hostOwner,
    hostError: room === 'host' ? hostError : null,
    justCreated: created,
  };
}

async function hostRoom(
  current: Runtime,
  owner: HostOwnerProfile | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (startedAsGuest) return { ok: false, error: 'Close and open the app again to host a room.' };
  await prepareHosting(current);
  await startHosting(current);
  if (hostError) return { ok: false, error: hostError };
  if (owner && !host!.hasOwner()) {
    const created = await host!.createOwner(owner);
    if (!created.ok) return created;
  }
  if (!host!.hasOwner()) return { ok: false, error: 'This room needs an owner first.' };
  current.settings.setHostOwner(true);
  current.settings.setRoom('host');
  if (owner) {
    const signedIn = await auth!.signInAsOwner();
    if (!signedIn.ok) log.warn('could not start the new owner session; the next start tries again');
    justCreated = true;
  }
  reloadWindow();
  return { ok: true };
}

async function leaveRoom(current: Runtime) {
  await host!.stop();
  current.settings.useHostedServer(null);
  current.settings.setRoom(null);
  current.livekitUrl = null;
  if (startedAsGuest) startAgain();
  else reloadWindow();
}

function startAgain() {
  session.defaultSession.flushStorageData();
  app.relaunch();
  app.quit();
}

function showWindow(current: Runtime) {
  if (!mainWindow) openWindow(current);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

let shownNotification: Notification | null = null;

function showAskingNote(current: Runtime, words: NoteWords) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;
  if (!Notification.isSupported()) return;
  if (isProofBuild()) {
    log.info(`proof build: a notification would say: ${words.title}`);
    return;
  }
  shownNotification?.close();
  const note = new Notification(words);
  shownNotification = note;
  const forget = () => {
    if (shownNotification === note) shownNotification = null;
  };
  note.on('close', forget);
  note.on('click', () => {
    forget();
    showWindow(current);
  });
  note.show();
}

const MAX_RENDERER_RECOVERIES = 2;
let rendererRecoveries = 0;

function openWindow(current: Runtime): void {
  mainWindow = createMainWindow(current);
  updateShortcuts(current.settings.get().shortcuts);
  const window = mainWindow;
  window.on('close', (event) => {
    if (quitting || closeAnswered || !host?.running()) return;
    event.preventDefault();
    void dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: ['Stop hosting', 'Keep hosting', 'Cancel'],
        defaultId: 1,
        cancelId: 2,
        message: 'Stop hosting this room?',
        detail:
          'If you stop, your guests see that the host is away until you host again. If you keep hosting, the room stays open with no window: open the app again to come back to it.',
      })
      .then(async ({ response }) => {
        if (response === 2 || window.isDestroyed()) return;
        if (response === 0) {
          await host?.stop();
          current.settings.useHostedServer(null);
          current.settings.setRoom(null);
          current.livekitUrl = null;
        }
        closeAnswered = true;
        if (!window.isDestroyed()) window.close();
        closeAnswered = false;
        if (!host?.running() && process.platform !== 'darwin') app.quit();
      });
  });
  mainWindow.on('closed', () => {
    capture?.forget();
    releaseShortcuts();
    shortcutState = EMPTY_SHORTCUTS;
    mainWindow = null;
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (rendererRecoveries >= MAX_RENDERER_RECOVERIES) {
      log.error(`the renderer stopped again (${details.reason}); not reloading it any more`);
      return;
    }
    rendererRecoveries += 1;
    log.error(`the renderer stopped (${details.reason}); reloading it`);
    if (runtime && mainWindow && !mainWindow.isDestroyed())
      void mainWindow.loadURL(runtime.target.url);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log.error(loadFailure(code, description, url));
  });
  mainWindow.webContents.on('preload-error', (_event, _path, error) =>
    log.error(`the window's preload failed: ${messageOf(error)}`),
  );
  mainWindow.webContents.on('unresponsive', () => log.warn('the window stopped responding'));
  mainWindow.webContents.on('responsive', () => log.info('the window responds again'));
  void mainWindow.loadURL(current.target.url);
}

async function onReady(
  profile: string,
  userDataDir: string,
  target: RendererTarget,
): Promise<void> {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin' && !app.isPackaged) {
    const icon = unpackagedDockIcon(__dirname);
    if (icon) app.dock?.setIcon(icon);
  }

  const current = createRuntime(profile, userDataDir, target);
  runtime = current;
  auth = createAuthService(current, () => host?.ownerSecret() ?? null);
  capture = createCaptureService();
  host = createHostService(
    userDataDir,
    broadcastHosting,
    hostOptions(),
    noteEachAsking((words) => showAskingNote(current, words), process.platform),
  );
  const hostedBefore = current.settings.get().room === 'host';

  if (hostedBefore) await prepareHosting(current);

  registerAppProtocol(current);
  registerBridgeProtocol(current, bridgeSession(), gatewayPortForPolicy, testRelays());

  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession, target);
  installDisplayMediaHandler(defaultSession, capture, target);
  if (target.devOrigin) installDevelopmentCsp(defaultSession, current, target.devOrigin);

  registerBridgeHandlers({
    runtime: current,
    auth,
    capture,
    mainWindow: () => mainWindow,
    room: {
      get: () => roomState(current),
      host: (owner) => hostRoom(current, owner),
      join() {
        current.settings.setRoom('guest');
        reloadWindow();
      },
      leave: () => leaveRoom(current),
      status: () => host!.status(),
      newCode: async () => {
        await host!.newCode();
        return host!.status();
      },
    },
    shortcuts: { current: () => shortcutState, update: updateShortcuts },
  });

  powerMonitor.on('suspend', () => send(EVENT.power, 'suspend'));
  powerMonitor.on('resume', () => send(EVENT.power, 'resume'));
  powerMonitor.on('lock-screen', () => send(EVENT.power, 'lock-screen'));
  powerMonitor.on('unlock-screen', () => send(EVENT.power, 'unlock-screen'));

  openWindow(current);
  if (hostedBefore) void startHosting(current);
}

function gatewayPortForPolicy(): number {
  return host?.portsNow()?.gateway ?? 0;
}

function hostOptions() {
  const stun = app.isPackaged ? '' : (process.env.HOSTILE_TEST_STUN ?? '');
  return stun ? { stunServers: stun.split(',').filter(Boolean) } : {};
}

const TEST_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'use-fake-device-for-media-stream',
  'use-fake-ui-for-media-stream',
  'use-file-for-fake-audio-capture',
  'use-file-for-fake-video-capture',
];

function start(): void {
  if (app.isPackaged && !isProofBuild()) {
    const found = TEST_SWITCHES.filter((name) => app.commandLine.hasSwitch(name));
    if (found.length) {
      log.error(`not starting: a packaged app does not accept --${found.join(', --')}`);
      app.exit(1);
      return;
    }
  }
  const { profile, rejected } = readProfileArg(process.argv);
  if (rejected !== null) {
    log.warn(`ignoring --profile=${rejected}: use 1-32 characters from a-z, 0-9, "-" and "_"`);
  }
  const userDataDir = applyProfile(profile);

  if (!app.requestSingleInstanceLock()) {
    log.info(`profile "${profile}" is already running; bringing that window to the front`);
    app.quit();
    return;
  }

  startedAsGuest = createSettingsStore(userDataDir).get().room === 'guest';
  if (!startedAsGuest) {
    app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
  }

  registerAppSchemePrivileges();
  const target = resolveRendererTarget();

  app.on('second-instance', () => {
    if (runtime) showWindow(runtime);
  });

  app.on('web-contents-created', (_event, contents) => installNavigationGuards(contents, target));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !host?.running()) app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && runtime) openWindow(runtime);
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (!host?.running()) return;
    event.preventDefault();
    void host.stop().finally(() => app.quit());
  });

  app.on('will-quit', () => releaseShortcuts());

  void app
    .whenReady()
    .then(() => onReady(profile, userDataDir, target))
    .catch((err: unknown) => {
      log.error(`could not start: ${String(err)}`);
      app.quit();
    });
}

start();
