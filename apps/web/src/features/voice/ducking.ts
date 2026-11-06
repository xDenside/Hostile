export const DUCKING_LEVEL_MIN = 0.05;
export const DUCKING_LEVEL_MAX = 0.7;
export const DUCKING_LEVEL_DEFAULT = 0.25;

export const SPEECH_RMS = 0.008;

const SPEECH_CONFIRM_MS = 80;
const HOLD_MS = 450;
const ATTACK_MS = 120;
const RELEASE_MS = 700;

export interface DuckState {
  gain: number;
  speechSince: number | null;
  lastSpeechAt: number;
  updatedAt: number;
}

export function initialDuckState(now: number): DuckState {
  return { gain: 1, speechSince: null, lastSpeechAt: -Infinity, updatedAt: now };
}

function shouldDuck(state: DuckState, speech: boolean, now: number): DuckState & { duck: boolean } {
  const speechSince = speech ? (state.speechSince ?? now) : null;
  const confirmed = speechSince !== null && now - speechSince >= SPEECH_CONFIRM_MS;
  const lastSpeechAt = confirmed ? now : state.lastSpeechAt;
  return { ...state, speechSince, lastSpeechAt, duck: now - lastSpeechAt < HOLD_MS };
}

export function advanceDuck(
  previous: DuckState,
  input: { speech: boolean; level: number; now: number },
): DuckState {
  const { duck, ...state } = shouldDuck(previous, input.speech, input.now);
  const dt = Math.max(0, input.now - previous.updatedAt);
  const target = duck ? input.level : 1;
  const span = 1 - input.level;
  const step = span <= 0 ? 1 : (span * dt) / (duck ? ATTACK_MS : RELEASE_MS);
  const gain =
    state.gain > target ? Math.max(target, state.gain - step) : Math.min(target, state.gain + step);
  return { ...state, gain, updatedAt: input.now };
}

export function speakersThatDuck(
  speaking: Iterable<string>,
  selfId: string | null,
  isSilencedHere: (userId: string) => boolean,
): string[] {
  return [...speaking].filter((id) => id !== selfId && !isSilencedHere(id));
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
