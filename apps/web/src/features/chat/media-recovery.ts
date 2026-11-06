import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useCommunity } from '../../stores/community';

export type MediaFailure = 'missing' | 'broken' | 'unreachable';

export type FileProbe = 'present' | 'missing' | 'unreachable';

export async function probeFile(url: string): Promise<FileProbe> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return 'present';
    return res.status === 404 || res.status === 410 ? 'missing' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function imageFailureFrom(
  probe: FileProbe,
  alreadyRetried: boolean,
): MediaFailure | 'retry' {
  if (probe === 'present') return alreadyRetried ? 'broken' : 'retry';
  return probe;
}

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

export function videoFailureFromCode(code: number | undefined): 'ignore' | 'broken' | 'ask' {
  if (code === MEDIA_ERR_ABORTED) return 'ignore';
  return code === MEDIA_ERR_DECODE ? 'broken' : 'ask';
}

export function videoFailureFrom(
  code: number | undefined,
  probe: FileProbe,
  alreadyRetried: boolean,
): MediaFailure | 'retry' {
  if (probe !== 'present') return probe;
  if (code === MEDIA_ERR_NETWORK) return 'unreachable';
  return alreadyRetried ? 'broken' : 'retry';
}

export const MEDIA_RETRY_MS = 15_000;

const waiting = new Set<() => void>();
let stopListening: (() => void) | null = null;

function retryEverything() {
  for (const retry of [...waiting]) retry();
}

function startListening(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') retryEverything();
  };
  window.addEventListener('online', retryEverything);
  document.addEventListener('visibilitychange', onVisible);
  const offConnection = useCommunity.subscribe((now, before) => {
    if (now.connection === 'connected' && before.connection !== 'connected') retryEverything();
  });
  const timer = setInterval(retryEverything, MEDIA_RETRY_MS);
  return () => {
    window.removeEventListener('online', retryEverything);
    document.removeEventListener('visibilitychange', onVisible);
    offConnection();
    clearInterval(timer);
  };
}

export function whenWorthRetrying(retry: () => void): () => void {
  if (!waiting.size) stopListening = startListening();
  waiting.add(retry);
  return () => {
    waiting.delete(retry);
    if (waiting.size) return;
    stopListening?.();
    stopListening = null;
  };
}

export function useMediaLoad(url: string) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  const retried = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const tryAgain = useCallback(() => {
    generation.current += 1;
    setFailure(null);
    setAttempt((a) => a + 1);
  }, []);

  const settle = useCallback(
    (outcome: MediaFailure | 'retry') => {
      if (outcome === 'retry') {
        retried.current = true;
        tryAgain();
      } else {
        setFailure(outcome);
      }
    },
    [tryAgain],
  );

  const imageFailed = useCallback(async () => {
    const asked = generation.current;
    const probe = await probeFile(url);
    if (asked === generation.current) settle(imageFailureFrom(probe, retried.current));
  }, [settle, url]);

  const videoFailed = useCallback(
    async (code: number | undefined) => {
      const settled = videoFailureFromCode(code);
      if (settled === 'ignore') return;
      if (settled === 'broken') return setFailure('broken');
      const asked = generation.current;
      const probe = await probeFile(url);
      if (asked === generation.current) settle(videoFailureFrom(code, probe, retried.current));
    },
    [settle, url],
  );

  const loaded = useCallback(() => {
    retried.current = false;
  }, []);

  useEffect(
    () => (failure === 'unreachable' ? whenWorthRetrying(tryAgain) : undefined),
    [failure, tryAgain],
  );

  return { attempt, failure, tryAgain, imageFailed, videoFailed, loaded };
}

const NEAR_MARGIN_PX = 800;

export function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries[entries.length - 1]!.isIntersecting),
      { root: el.closest('[role="log"]'), rootMargin: `${NEAR_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

export function useVideoRelease(
  ref: RefObject<HTMLVideoElement | null>,
  src: string,
  onRelease?: (el: HTMLVideoElement) => void,
) {
  const report = useRef(onRelease);
  useEffect(() => {
    report.current = onRelease;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.getAttribute('src')) el.setAttribute('src', src);
    return () => {
      report.current?.(el);
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, [ref, src]);
}
