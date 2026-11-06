import { create } from 'zustand';
import type { SelfUser } from '@hostile/shared';

export type SessionStatus =
  'booting' | 'room-choice' | 'join' | 'unreachable' | 'ask' | 'signed-in';

interface SessionState {
  status: SessionStatus;
  user: SelfUser | null;
  notice: string | null;
  bootError: string | null;
}

export const useSession = create<SessionState>(() => ({
  status: 'booting',
  user: null,
  notice: null,
  bootError: null,
}));
