import { create } from 'zustand';
import { loadJson, saveJson } from '../lib/storage';

export type SettingsTab =
  'hosting' | 'profile' | 'voice' | 'shortcuts' | 'diagnostics' | 'members' | 'channels';

export interface MemberPopup {
  kind: 'member-menu' | 'share-menu' | 'profile';
  userId: string;
  x: number;
  y: number;
}

export interface MessagePopup {
  kind: 'message-menu';
  channelId: string;
  messageId: string;
  attachmentId: string | null;
  selection: string;
  listScrollTop: number;
  listHeight: number;
  x: number;
  y: number;
}

export type Popup = MemberPopup | MessagePopup;

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  ttlMs: number;
}

interface UiState {
  selectedChannelId: string | null;
  memberListOpen: boolean;
  sidebarWidth: number;
  settingsTab: SettingsTab | null;
  screenPickerOpen: boolean;
  focusedShare: string | null;
  popup: Popup | null;
  voiceChatOpen: boolean;
  phoneChatOpen: boolean;
  navOpen: boolean;
  capturingKeys: boolean;
  toasts: Toast[];
}

export const SIDEBAR_WIDTH = { min: 220, default: 276, max: 520 } as const;

const SPACE_FOR_THE_REST = 560;

export function clampSidebarWidth(width: number, windowWidth = Infinity): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  const limit = Math.max(
    SIDEBAR_WIDTH.min,
    Math.min(SIDEBAR_WIDTH.max, windowWidth - SPACE_FOR_THE_REST),
  );
  return Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(limit, width)));
}

const prefs = loadJson<{
  memberListOpen?: boolean;
  voiceChatOpen?: boolean;
  sidebarWidth?: number;
}>('ui', {});

export const useUi = create<UiState>(() => ({
  selectedChannelId: null,
  memberListOpen: prefs.memberListOpen ?? true,
  sidebarWidth: clampSidebarWidth(prefs.sidebarWidth ?? SIDEBAR_WIDTH.default),
  settingsTab: null,
  screenPickerOpen: false,
  focusedShare: null,
  popup: null,
  voiceChatOpen: prefs.voiceChatOpen ?? true,
  phoneChatOpen: false,
  navOpen: false,
  capturingKeys: false,
  toasts: [],
}));

useUi.subscribe((s, prev) => {
  if (
    s.memberListOpen !== prev.memberListOpen ||
    s.voiceChatOpen !== prev.voiceChatOpen ||
    s.sidebarWidth !== prev.sidebarWidth
  )
    saveJson('ui', {
      memberListOpen: s.memberListOpen,
      voiceChatOpen: s.voiceChatOpen,
      sidebarWidth: s.sidebarWidth,
    });
});

export function openPopup(popup: Popup) {
  useUi.setState({ popup });
}

export function closePopup() {
  useUi.setState({ popup: null });
}

let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', ttlMs = 5000) {
  const id = ++toastId;
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, ttlMs }] }));
  setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number) {
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function selectChannel(channelId: string | null, userId?: string) {
  useUi.setState({
    selectedChannelId: channelId,
    popup: null,
    navOpen: false,
    phoneChatOpen: false,
  });
  if (userId && channelId) saveJson(`lastChannel:${userId}`, channelId);
}

export function lastChannelFor(userId: string): string | null {
  return loadJson<string | null>(`lastChannel:${userId}`, null);
}
