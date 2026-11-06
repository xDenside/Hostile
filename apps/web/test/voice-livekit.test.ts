import { Room, supportsAudioOutputSelection } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLiveKit, supportsOutputSelection } from '../src/features/voice/livekit';

const AGENTS = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  electron:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hostile/0.1.0 Chrome/138.0.0.0 Electron/38.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeOnIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxOnIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};

afterEach(() => vi.unstubAllGlobals());

describe('choosing an output device, without loading LiveKit to ask', () => {
  for (const [name, userAgent] of Object.entries(AGENTS)) {
    for (const hasSinkId of [true, false]) {
      it(`agrees with LiveKit for ${name} ${hasSinkId ? 'with' : 'without'} setSinkId`, () => {
        vi.stubGlobal('navigator', { userAgent });
        vi.stubGlobal('document', {
          createElement: () => (hasSinkId ? { setSinkId: () => undefined } : {}),
        });
        expect(supportsOutputSelection()).toBe(supportsAudioOutputSelection());
      });
    }
  }
});

describe('LiveKit on demand', () => {
  it('keeps LiveKit from retaining every Room it ever made', async () => {
    expect(Object.hasOwn(Room, 'cleanupRegistry')).toBe(true);
    const lk = await loadLiveKit();
    expect(lk.Room).toBe(Room);
    expect(Room.cleanupRegistry).toBe(false);
  });
});
