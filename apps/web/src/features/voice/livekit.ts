export type LiveKit = typeof import('livekit-client');

const PRELOAD_AFTER_MS = 2000;
const PRELOAD_IDLE_TIMEOUT_MS = 5000;

let pending: Promise<LiveKit> | null = null;

export function loadLiveKit(): Promise<LiveKit> {
  pending ??= import('livekit-client').then(
    (lk) => {
      lk.Room.cleanupRegistry = false;
      return lk;
    },
    (err: unknown) => {
      pending = null;
      console.warn('Could not load LiveKit', err);
      throw new Error('Could not load the voice code. Check your connection, or reload the page.');
    },
  );
  return pending;
}

export function preloadLiveKit(): void {
  loadLiveKit().catch(() => undefined);
}

export function preloadLiveKitWhenIdle(): void {
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(preloadLiveKit, { timeout: PRELOAD_IDLE_TIMEOUT_MS });
    } else {
      preloadLiveKit();
    }
  }, PRELOAD_AFTER_MS);
}

export function supportsOutputSelection(): boolean {
  const agent = navigator.userAgent.toLowerCase();
  const safariBased =
    /fxios|crios/.test(agent) ||
    (!/firefox|iceweasel|chrom|crmo/.test(agent) && /safari|applewebkit/.test(agent));
  return !safariBased && 'setSinkId' in document.createElement('audio');
}
