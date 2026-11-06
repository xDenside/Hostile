import deafenUrl from './sounds/deafen.mp3?no-inline';
import joinUrl from './sounds/join.mp3?no-inline';
import leaveUrl from './sounds/leave.mp3?no-inline';
import muteUrl from './sounds/mute.mp3?no-inline';
import shareStartUrl from './sounds/share-start.mp3?no-inline';
import shareStopUrl from './sounds/share-stop.mp3?no-inline';
import undeafenUrl from './sounds/undeafen.mp3?no-inline';
import unmuteUrl from './sounds/unmute.mp3?no-inline';
import viewerJoinUrl from './sounds/viewer-join.mp3?no-inline';
import { useVoice } from './store';

export type SoundCue =
  | 'join'
  | 'leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'share-start'
  | 'share-stop'
  | 'viewer-join';

const CUE_URLS: Record<SoundCue, string> = {
  join: joinUrl,
  leave: leaveUrl,
  mute: muteUrl,
  unmute: unmuteUrl,
  deafen: deafenUrl,
  undeafen: undeafenUrl,
  'share-start': shareStartUrl,
  'share-stop': shareStopUrl,
  'viewer-join': viewerJoinUrl,
};

export const CUE_LABELS: readonly { cue: SoundCue; label: string }[] = [
  { cue: 'join', label: 'Someone joins' },
  { cue: 'leave', label: 'Someone leaves' },
  { cue: 'mute', label: 'Mute' },
  { cue: 'unmute', label: 'Unmute' },
  { cue: 'deafen', label: 'Deafen' },
  { cue: 'undeafen', label: 'Undeafen' },
  { cue: 'share-start', label: 'Screen share starts' },
  { cue: 'share-stop', label: 'Screen share stops' },
  { cue: 'viewer-join', label: 'Someone joins your stream' },
];

const MASTER_LEVEL = 0.5;
const REPEAT_WINDOW_MS = 120;
const STALE_AFTER_MS = 400;
const CUE_GAP_SEC = 0.05;
const MAX_QUEUE_SEC = 0.9;
const IDLE_SUSPEND_MS = 2000;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let idleTimer: number | undefined;
let busyUntil = 0;
const lastPlayed: Partial<Record<SoundCue, number>> = {};
const files = new Map<SoundCue, Promise<ArrayBuffer>>();
const buffers = new Map<SoundCue, Promise<AudioBuffer | null>>();

type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

function routeTo(ctx: AudioContext, deviceId: string): void {
  const sinkable = ctx as SinkableContext;
  if (typeof sinkable.setSinkId !== 'function') return;
  sinkable.setSinkId(deviceId === 'default' ? '' : deviceId).catch(() => undefined);
}

function audioContext(): AudioContext | null {
  if (context && context.state !== 'closed') return context;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
    busyUntil = 0;
    buffers.clear();
  } catch {
    return null;
  }
  master = context.createGain();
  master.gain.value = MASTER_LEVEL;
  master.connect(context.destination);
  routeTo(context, useVoice.getState().outputDeviceId);
  return context;
}

useVoice.subscribe((s, prev) => {
  if (context && s.outputDeviceId !== prev.outputDeviceId) routeTo(context, s.outputDeviceId);
});

function fetchCue(cue: SoundCue): Promise<ArrayBuffer> {
  let pending = files.get(cue);
  if (!pending) {
    pending = fetch(CUE_URLS[cue]).then((res) => {
      if (!res.ok) throw new Error(`Sound ${cue}: ${res.status}`);
      return res.arrayBuffer();
    });
    pending.catch(() => files.delete(cue));
    files.set(cue, pending);
  }
  return pending;
}

function loadCue(ctx: AudioContext, cue: SoundCue): Promise<AudioBuffer | null> {
  let pending = buffers.get(cue);
  if (!pending) {
    pending = fetchCue(cue)
      .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
      .catch(() => {
        buffers.delete(cue);
        return null;
      });
    buffers.set(cue, pending);
  }
  return pending;
}

export function preloadCues(): void {
  if (!useVoice.getState().callSounds) return;
  for (const cue of Object.keys(CUE_URLS) as SoundCue[]) void fetchCue(cue).catch(() => undefined);
}

function schedule(ctx: AudioContext, buffer: AudioBuffer): number | null {
  const start = Math.max(ctx.currentTime + 0.01, busyUntil);
  if (start - ctx.currentTime > MAX_QUEUE_SEC) return null;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(master!);
  source.onended = () => source.disconnect();
  source.start(start);
  const end = start + buffer.duration;
  busyUntil = end + CUE_GAP_SEC;
  return end - ctx.currentTime;
}

function suspendWhenIdle(ctx: AudioContext, afterSec: number): void {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(
    () => {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    },
    afterSec * 1000 + IDLE_SUSPEND_MS,
  );
}

function start(cue: SoundCue): void {
  const now = performance.now();
  if (now - (lastPlayed[cue] ?? -Infinity) < REPEAT_WINDOW_MS) return;
  lastPlayed[cue] = now;
  const ctx = audioContext();
  if (!ctx) return;
  const running = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
  void Promise.all([loadCue(ctx, cue), running]).then(
    ([buffer]) => {
      if (!buffer || performance.now() - now > STALE_AFTER_MS || ctx.state !== 'running') return;
      const remaining = schedule(ctx, buffer);
      if (remaining !== null) suspendWhenIdle(ctx, remaining);
    },
    () => undefined,
  );
}

export function playCue(cue: SoundCue): void {
  if (useVoice.getState().callSounds) start(cue);
}

export function previewCue(cue: SoundCue): void {
  start(cue);
}
