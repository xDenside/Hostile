export type NoiseSuppressionMode = 'off' | 'standard' | 'enhanced' | 'strong';

export const NOISE_SUPPRESSION_MODES: readonly NoiseSuppressionMode[] = [
  'off',
  'standard',
  'enhanced',
  'strong',
];

export type InAppSuppressor = 'rnnoise' | 'fastenhancer';

export type SuppressorFailures = Partial<Record<InAppSuppressor, string>>;

export function suppressorFor(mode: NoiseSuppressionMode): InAppSuppressor | null {
  if (mode === 'enhanced') return 'rnnoise';
  if (mode === 'strong') return 'fastenhancer';
  return null;
}

export const SUPPRESSOR_MODE_NAMES: Record<InAppSuppressor, string> = {
  rnnoise: 'Enhanced',
  fastenhancer: 'Strong',
};

export interface AudioProcessing {
  echoCancellation: boolean;
  noiseMode: NoiseSuppressionMode;
  noiseModeChosen: boolean;
  autoGainControl: boolean;
}

export const defaultAudioProcessing: AudioProcessing = {
  echoCancellation: true,
  noiseMode: 'strong',
  noiseModeChosen: false,
  autoGainControl: true,
};

export function inAppSuppressionSupported(scope: object = globalThis): boolean {
  const found = scope as {
    WebAssembly?: unknown;
    AudioWorkletNode?: unknown;
    AudioContext?: unknown;
  };
  const prototype = (found.AudioContext as { prototype?: unknown } | undefined)?.prototype;
  return (
    typeof found.WebAssembly === 'object' &&
    found.WebAssembly !== null &&
    typeof found.AudioWorkletNode === 'function' &&
    typeof found.AudioContext === 'function' &&
    typeof prototype === 'object' &&
    prototype !== null &&
    'audioWorklet' in prototype
  );
}

export function defaultNoiseMode(inAppSupported: boolean): NoiseSuppressionMode {
  return inAppSupported ? defaultAudioProcessing.noiseMode : 'standard';
}

export function fallbackIsQuiet(processing: AudioProcessing, failed: InAppSuppressor): boolean {
  return !processing.noiseModeChosen && suppressorFor(processing.noiseMode) === failed;
}

export interface CaptureConstraints {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  voiceIsolation: boolean;
  autoGainControl: boolean;
}

export function isNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return NOISE_SUPPRESSION_MODES.includes(value as NoiseSuppressionMode);
}

function storedNoiseChoice(stored: Record<string, unknown>): NoiseSuppressionMode | null {
  if (isNoiseSuppressionMode(stored.noiseMode)) {
    return stored.noiseModeChosen === false ? null : stored.noiseMode;
  }
  if (typeof stored.noiseSuppression === 'boolean') {
    return stored.noiseSuppression ? 'standard' : 'off';
  }
  return null;
}

function storedFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function migrateAudioProcessing(raw: unknown, inAppSupported = true): AudioProcessing {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const chosen = storedNoiseChoice(stored);
  return {
    echoCancellation: storedFlag(stored.echoCancellation, defaultAudioProcessing.echoCancellation),
    noiseMode: chosen ?? defaultNoiseMode(inAppSupported),
    noiseModeChosen: chosen !== null,
    autoGainControl: storedFlag(stored.autoGainControl, defaultAudioProcessing.autoGainControl),
  };
}

export function effectiveNoiseMode(
  mode: NoiseSuppressionMode,
  failures: SuppressorFailures,
): NoiseSuppressionMode {
  const suppressor = suppressorFor(mode);
  return suppressor && failures[suppressor] ? 'standard' : mode;
}

export function captureConstraints(
  processing: AudioProcessing,
  failures: SuppressorFailures,
): CaptureConstraints {
  const browserSuppression = effectiveNoiseMode(processing.noiseMode, failures) === 'standard';
  return {
    echoCancellation: processing.echoCancellation,
    noiseSuppression: browserSuppression,
    voiceIsolation: browserSuppression,
    autoGainControl: processing.autoGainControl,
  };
}

export function sameCaptureConstraints(a: CaptureConstraints, b: CaptureConstraints): boolean {
  return (
    a.echoCancellation === b.echoCancellation &&
    a.noiseSuppression === b.noiseSuppression &&
    a.voiceIsolation === b.voiceIsolation &&
    a.autoGainControl === b.autoGainControl
  );
}
