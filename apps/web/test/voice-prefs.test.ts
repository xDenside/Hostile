import { beforeEach, describe, expect, it } from 'vitest';
import type { SelfUser } from '@hostile/shared';

const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { defaultBindings, isMacLike } = await import('../src/features/shortcuts/bindings');
const { useVoice } = await import('../src/features/voice/store');
const { useSession } = await import('../src/stores/session');

function user(id: string): SelfUser {
  return {
    id,
    displayName: id,
    avatarColor: '#888888',
    avatarUrl: null,
    bannerUrl: null,
    bannerColor: null,
    nameFont: 'default',
    nameEffect: 'none',
    nameColor: null,
    nameColor2: null,
    customStatus: null,
    role: 'member',
    disabled: false,
    createdAt: '2026-01-02T03:04:05.000Z',
  };
}

function signIn(id: string) {
  useSession.setState({ status: 'signed-in', user: user(id), notice: null, bootError: null });
}

function signOut() {
  useSession.setState({ status: 'ask', user: null });
}

function stored(key: string): Record<string, unknown> | null {
  const raw = store.get(`hostile:${key}`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('voice preferences', () => {
  beforeEach(() => {
    store.clear();
    signOut();
  });

  it('keeps per-person volumes and mute with the account, not the machine', () => {
    signIn('alice');
    useVoice.setState({ volumes: { ivan: 0.2 }, streamVolumes: { ivan: 0.5 }, micMuted: true });
    expect(stored('voice-prefs:alice')).toEqual({
      volumes: { ivan: 0.2 },
      streamVolumes: { ivan: 0.5 },
      localMutes: {},
      streamDucking: false,
      duckingLevel: 0.25,
      micMuted: true,
      callSounds: true,
      shortcuts: defaultBindings(isMacLike()),
    });
    expect(stored('voice-prefs')).toBe(null);

    signOut();
    expect(useVoice.getState().volumes).toEqual({});
    expect(useVoice.getState().streamVolumes).toEqual({});
    expect(useVoice.getState().micMuted).toBe(false);

    signIn('bob');
    expect(useVoice.getState().volumes).toEqual({});
    expect(useVoice.getState().micMuted).toBe(false);
    useVoice.setState({ volumes: { ivan: 1.5 } });
    expect(stored('voice-prefs:bob')).toMatchObject({ volumes: { ivan: 1.5 } });
    expect(stored('voice-prefs:alice')).toMatchObject({ volumes: { ivan: 0.2 }, micMuted: true });
  });

  it('restores the signed-in account’s own volumes when it comes back', () => {
    signIn('alice');
    useVoice.setState({ volumes: { ivan: 0.2 }, micMuted: true });
    signOut();
    signIn('bob');
    useVoice.setState({ volumes: { ivan: 1.5 } });
    signOut();
    signIn('alice');
    expect(useVoice.getState().volumes).toEqual({ ivan: 0.2 });
    expect(useVoice.getState().micMuted).toBe(true);
  });

  it('does not overwrite saved volumes while signed out', () => {
    signIn('alice');
    useVoice.setState({ volumes: { ivan: 0.2 } });
    signOut();
    useVoice.setState({ volumes: {}, micMuted: false });
    expect(stored('voice-prefs:alice')).toMatchObject({ volumes: { ivan: 0.2 } });
  });

  it('keeps device and processing choices machine-wide', () => {
    signIn('alice');
    useVoice.setState({ inputDeviceId: 'mic-1', outputDeviceId: 'speaker-1' });
    expect(stored('voice-prefs')).toMatchObject({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speaker-1',
    });
    expect(stored('voice-prefs')).not.toHaveProperty('volumes');
    signOut();
    signIn('bob');
    expect(useVoice.getState().inputDeviceId).toBe('mic-1');
  });
});
