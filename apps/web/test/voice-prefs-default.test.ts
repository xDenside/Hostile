import { describe, expect, it } from 'vitest';

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};
class FakeContext {
  get audioWorklet() {
    return {};
  }
}
Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: function () {} });

const { useVoice } = await import('../src/features/voice/store');

describe('a new profile on a device that can run the in-app suppressors', () => {
  it('starts on strong, as a default and not a choice', () => {
    expect(useVoice.getState().processing).toMatchObject({
      noiseMode: 'strong',
      noiseModeChosen: false,
    });
  });

  it('saves the default as a default when something else is saved', () => {
    useVoice.setState({ inputDeviceId: 'mic-2' });
    expect(JSON.parse(store.get('hostile:voice-prefs')!).processing).toMatchObject({
      noiseMode: 'strong',
      noiseModeChosen: false,
    });
  });
});
