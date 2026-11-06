import type { SelfUser, SessionEndReason } from '@hostile/shared';
import { ApiError, endpoints, errorMessage } from '../api/client';
import { loadDrafts, resetChat, saveDraftsNow } from '../features/chat/store';
import { voice } from '../features/voice/controller';
import { preloadLiveKitWhenIdle } from '../features/voice/livekit';
import { desktopRoom, platform } from '../platform';
import { isGuestBuild } from '../tunnel/net';
import { useTunnel } from '../tunnel/state';
import {
  connectRealtime,
  disconnectRealtime,
  kickRealtime,
  nudgeRealtime,
} from '../realtime/socket';
import { resetCommunity } from '../stores/community';
import { useSession } from '../stores/session';
import { toast } from '../stores/ui';
import { lastChannelFor, selectChannel, useUi } from '../stores/ui';

const END_MESSAGES: Record<SessionEndReason | 'auth', string> = {
  logout: 'You left this room.',
  revoked: 'This device was ended from another one.',
  expired: 'This device is no longer part of the room.',
  disabled: 'The host removed you from this room. You can ask to join again, as someone new.',
  auth: 'This device is no longer part of the room.',
};

export function keepThisDevice() {
  if (!isGuestBuild()) return;
  void navigator.storage?.persist?.().catch(() => undefined);
}

export function enterApp(user: SelfUser) {
  loadDrafts(user.id);
  selectChannel(lastChannelFor(user.id));
  useSession.setState({ status: 'signed-in', user, notice: null, bootError: null });
  connectRealtime((reason) => void endSession(reason));
  preloadLiveKitWhenIdle();
  keepThisDevice();
  const room = desktopRoom();
  if (room?.justCreated) {
    room.justCreated = false;
    useUi.setState({ settingsTab: 'hosting' });
  }
}

export async function boot(): Promise<void> {
  const room = desktopRoom();
  if (room?.role === 'none') {
    useSession.setState({ status: 'room-choice' });
    return;
  }
  if (room?.hostError) {
    useSession.setState({ status: 'unreachable', bootError: room.hostError });
    return;
  }
  if (room?.role === 'host' && !room.ownerExists) {
    useSession.setState({ status: 'room-choice' });
    return;
  }
  if (isGuestBuild() && useTunnel.getState().phase !== 'connected') {
    const { resumeOrAsk } = await import('./join');
    if (!(await resumeOrAsk())) return;
  }
  try {
    const user = await platform().restoreSession();
    if (user) enterApp(user);
    else useSession.setState({ status: 'ask', bootError: null });
  } catch (err) {
    const unavailable = err instanceof ApiError && (err.isNetwork || err.status >= 500);
    useSession.setState({
      status: unavailable ? 'unreachable' : 'ask',
      bootError: errorMessage(err),
    });
  }
}

function leaveApp(notice: string | null) {
  void voice().leave();
  disconnectRealtime();
  resetChat();
  resetCommunity();
  useUi.setState({
    selectedChannelId: null,
    settingsTab: null,
    navOpen: false,
    phoneChatOpen: false,
    screenPickerOpen: false,
    focusedShare: null,
  });
  useSession.setState({ status: 'ask', user: null, notice });
}

export async function leaveRoom(): Promise<boolean> {
  try {
    await endpoints.leave();
  } catch (err) {
    const goneAnyway = isGuestBuild() && useTunnel.getState().phase === 'ended';
    if (!goneAnyway && (!(err instanceof ApiError) || err.status !== 401)) {
      toast(
        `Could not leave: ${errorMessage(err)} Check your connection and try again.`,
        'error',
        8000,
      );
      return false;
    }
  }
  leaveApp(null);
  if (isGuestBuild()) {
    const { forgetRoom } = await import('../tunnel/guest');
    forgetRoom({ endIdentity: true });
    useSession.setState({ status: 'join' });
    await platform().desktop?.room.leave();
  }
  return true;
}

export async function changeRoomCode(): Promise<void> {
  const { forgetRoom } = await import('../tunnel/guest');
  leaveApp(null);
  platform().dropCredentials();
  forgetRoom();
  useSession.setState({ status: 'join' });
}

export async function endSession(reason: SessionEndReason | 'auth'): Promise<void> {
  if (useSession.getState().status !== 'signed-in') return;
  platform().dropCredentials();
  if (platform().kind === 'desktop') {
    await platform()
      .logout()
      .catch(() => undefined);
  }
  leaveApp(END_MESSAGES[reason]);
}

const CATCH_UP_AFTER_HIDDEN_MS = 30_000;

let connectivityDisposer: (() => void) | null = null;

export function installConnectivityHooks(): () => void {
  if (connectivityDisposer) return connectivityDisposer;
  const onOnline = () => kickRealtime();
  let hiddenAt: number | null = null;
  const onVisible = () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt ??= Date.now();
      return;
    }
    const away = hiddenAt === null ? Infinity : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= CATCH_UP_AFTER_HIDDEN_MS) kickRealtime();
    else nudgeRealtime();
  };
  const onPageHide = () => saveDraftsNow();
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisible);
  const offPower = platform().desktop?.onPowerEvent((event) => {
    if (event === 'resume' || event === 'unlock-screen') kickRealtime();
  });
  const offShortcut = platform().desktop?.shortcuts.onTriggered((action) => {
    if (action === 'toggleMute') voice().toggleMute();
    if (action === 'toggleDeafen') voice().toggleDeafen();
  });
  connectivityDisposer = () => {
    connectivityDisposer = null;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisible);
    offPower?.();
    offShortcut?.();
  };
  return connectivityDisposer;
}
