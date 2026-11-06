import { describe, expect, it } from 'vitest';

const store = new Map<string, string>([
  [
    'hostile:voice-prefs',
    JSON.stringify({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'default',
      processing: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      screenSharePreset: '720p30',
    }),
  ],
]);
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { useVoice } = await import('../src/features/voice/store');

describe('stored voice preferences from an earlier version', () => {
  it('arrive as a noise mode, with the rest of the blob untouched', () => {
    const s = useVoice.getState();
    expect(s.processing).toEqual({
      echoCancellation: false,
      noiseMode: 'standard',
      noiseModeChosen: true,
      autoGainControl: true,
    });
    expect(s.inputDeviceId).toBe('mic-1');
    expect(s.screenSharePreset).toBe('720p30');
    expect(JSON.parse(store.get('hostile:voice-prefs')!)).toMatchObject({
      processing: { noiseSuppression: true },
    });
  });

  it('is saved in the new shape once a choice is made', () => {
    useVoice.setState({
      processing: {
        echoCancellation: false,
        noiseMode: 'enhanced',
        noiseModeChosen: true,
        autoGainControl: true,
      },
    });
    expect(JSON.parse(store.get('hostile:voice-prefs')!).processing).toEqual({
      echoCancellation: false,
      noiseMode: 'enhanced',
      noiseModeChosen: true,
      autoGainControl: true,
    });
  });
});
