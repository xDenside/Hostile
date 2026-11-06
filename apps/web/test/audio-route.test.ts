import { describe, expect, it } from 'vitest';
import {
  audioDeviceFor,
  effectiveVolume,
  maxVolume,
  mutedForMe,
  onIOS,
} from '../src/features/voice/audio-route';

const AGENTS = {
  chromeOnMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  safariOnMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  electron:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hostile/0.1.0 Chrome/138.0.0.0 Electron/38.0.0 Safari/537.36',
  chromeOnWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  chromeOnIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  ipadMobileSite:
    'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};

describe('which way incoming audio goes', () => {
  it('stays on Web Audio on every computer, the desktop app included', () => {
    for (const agent of [
      AGENTS.chromeOnMac,
      AGENTS.safariOnMac,
      AGENTS.electron,
      AGENTS.chromeOnWindows,
    ]) {
      expect(audioDeviceFor(agent, 0, 900)).toBe('computer');
    }
  });

  it('knows an iPhone, in any browser, since all of them are Safari underneath', () => {
    expect(audioDeviceFor(AGENTS.iphone, 5, 390)).toBe('iphone');
    expect(audioDeviceFor(AGENTS.chromeOnIphone, 5, 390)).toBe('iphone');
    expect(audioDeviceFor(AGENTS.ipod, 5, 320)).toBe('iphone');
  });

  it('tells an iPad from an iPhone, the one that says it is a Mac by its touch screen', () => {
    expect(audioDeviceFor(AGENTS.ipadMobileSite, 5, 820)).toBe('ipad');
    expect(audioDeviceFor(AGENTS.safariOnMac, 5, 820)).toBe('ipad');
    expect(audioDeviceFor(AGENTS.safariOnMac, 0, 900)).toBe('computer');
  });

  it('knows an iPhone asking for the desktop site, which says it is a Mac too, by its small screen', () => {
    expect(audioDeviceFor(AGENTS.safariOnMac, 5, 440)).toBe('iphone');
    expect(audioDeviceFor(AGENTS.safariOnMac, 5, 744)).toBe('ipad');
  });

  it('plays through elements on an iPhone or iPad only', () => {
    expect(onIOS('iphone')).toBe(true);
    expect(onIOS('ipad')).toBe(true);
    expect(onIOS('computer')).toBe(false);
  });

  it('keeps Android on Web Audio, which Chrome does not stop in the background', () => {
    expect(audioDeviceFor(AGENTS.androidChrome, 5, 412)).toBe('computer');
  });
});

describe('what a saved volume comes to', () => {
  it('is what it says on a computer, above 100% included', () => {
    expect(maxVolume('computer')).toBe(2);
    expect(effectiveVolume(1.5, 'computer')).toBe(1.5);
    expect(effectiveVolume(0, 'computer')).toBe(0);
  });

  it('stops at 100% on an iPad, where an element throws above it', () => {
    expect(maxVolume('ipad')).toBe(1);
    expect(effectiveVolume(1.5, 'ipad')).toBe(1);
    expect(effectiveVolume(0.5, 'ipad')).toBe(0.5);
    expect(effectiveVolume(0, 'ipad')).toBe(0);
  });

  it('means nothing on an iPhone, which has no control to change it back with', () => {
    expect(maxVolume('iphone')).toBe(0);
    expect(effectiveVolume(1.5, 'iphone')).toBe(1);
    expect(effectiveVolume(0, 'iphone')).toBe(1);
  });
});

describe('who is muted for me', () => {
  it('is whoever was muted for me, anywhere', () => {
    for (const device of ['computer', 'ipad', 'iphone'] as const) {
      expect(mutedForMe(true, 1, device)).toBe(true);
      expect(mutedForMe(false, undefined, device)).toBe(false);
      expect(mutedForMe(false, 0.5, device)).toBe(false);
    }
  });

  it('on an iPhone, is also whoever is saved at 0%, which it has no slider to undo', () => {
    expect(mutedForMe(false, 0, 'iphone')).toBe(true);
  });

  it('elsewhere leaves a person at 0% to the slider, which can still turn them up', () => {
    expect(mutedForMe(false, 0, 'computer')).toBe(false);
    expect(mutedForMe(false, 0, 'ipad')).toBe(false);
  });
});
