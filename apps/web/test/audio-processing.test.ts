import { describe, expect, it } from 'vitest';
import {
  captureConstraints,
  defaultAudioProcessing,
  defaultNoiseMode,
  effectiveNoiseMode,
  fallbackIsQuiet,
  inAppSuppressionSupported,
  migrateAudioProcessing,
  sameCaptureConstraints,
  type AudioProcessing,
} from '../src/features/voice/audio-processing';

const legacy = (noiseSuppression: boolean) => ({
  echoCancellation: true,
  noiseSuppression,
  autoGainControl: true,
});

describe('migrateAudioProcessing', () => {
  it('turns the old boolean into a mode: on meant the built-in suppressor, and counts as a choice', () => {
    expect(migrateAudioProcessing(legacy(true))).toEqual({
      echoCancellation: true,
      noiseMode: 'standard',
      noiseModeChosen: true,
      autoGainControl: true,
    });
  });

  it('turns the old boolean off into no suppression at all', () => {
    expect(migrateAudioProcessing(legacy(false)).noiseMode).toBe('off');
  });

  it('keeps the other two switches, including when they are off', () => {
    expect(
      migrateAudioProcessing({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    ).toEqual({
      echoCancellation: false,
      noiseMode: 'off',
      noiseModeChosen: true,
      autoGainControl: false,
    });
  });

  it('prefers a stored mode over a boolean left beside it', () => {
    expect(
      migrateAudioProcessing({ noiseMode: 'enhanced', noiseSuppression: false }).noiseMode,
    ).toBe('enhanced');
  });

  it('falls back to the defaults for nothing, rubbish and wrong types', () => {
    for (const raw of [undefined, null, 42, 'standard', [], { noiseMode: 'loud' }, {}]) {
      expect(migrateAudioProcessing(raw)).toEqual(defaultAudioProcessing);
    }
  });

  it('starts a new profile on strong, as a default rather than a choice', () => {
    expect(defaultAudioProcessing.noiseMode).toBe('strong');
    expect(defaultAudioProcessing.noiseModeChosen).toBe(false);
    expect(migrateAudioProcessing(undefined)).toMatchObject({
      noiseMode: 'strong',
      noiseModeChosen: false,
    });
  });

  it('starts on standard where no in-app suppressor can run, still as a default', () => {
    expect(migrateAudioProcessing(undefined, false)).toEqual({
      ...defaultAudioProcessing,
      noiseMode: 'standard',
      noiseModeChosen: false,
    });
    expect(defaultNoiseMode(false)).toBe('standard');
    expect(defaultNoiseMode(true)).toBe('strong');
  });

  it('keeps every saved mode from before the default changed, standard included', () => {
    for (const noiseMode of ['off', 'standard', 'enhanced', 'strong'] as const) {
      expect(
        migrateAudioProcessing({ echoCancellation: true, noiseMode, autoGainControl: true }),
      ).toEqual({
        echoCancellation: true,
        noiseMode,
        noiseModeChosen: true,
        autoGainControl: true,
      });
      expect(migrateAudioProcessing({ noiseMode }, false).noiseMode).toBe(noiseMode);
    }
  });

  it('keeps a saved choice even where it cannot run, so that it is tried and explained', () => {
    expect(
      migrateAudioProcessing({ noiseMode: 'strong', noiseModeChosen: true }, false),
    ).toMatchObject({ noiseMode: 'strong', noiseModeChosen: true });
  });

  it('works the default out again when what was saved was only the default', () => {
    expect(
      migrateAudioProcessing({
        echoCancellation: false,
        noiseMode: 'strong',
        noiseModeChosen: false,
      }),
    ).toEqual({
      echoCancellation: false,
      noiseMode: 'strong',
      noiseModeChosen: false,
      autoGainControl: true,
    });
    expect(
      migrateAudioProcessing({ noiseMode: 'strong', noiseModeChosen: false }, false),
    ).toMatchObject({ noiseMode: 'standard', noiseModeChosen: false });
    expect(migrateAudioProcessing({ noiseMode: 'off', noiseModeChosen: false })).toMatchObject({
      noiseMode: 'strong',
      noiseModeChosen: false,
    });
  });

  it('reads the old boolean as a choice even beside a default that was saved later', () => {
    expect(
      migrateAudioProcessing({ noiseSuppression: false, noiseModeChosen: false }),
    ).toMatchObject({ noiseMode: 'off', noiseModeChosen: true });
  });
});

describe('inAppSuppressionSupported', () => {
  class Context {
    get audioWorklet() {
      return {};
    }
  }
  const full = { WebAssembly: {}, AudioWorkletNode: function () {}, AudioContext: Context };

  it('needs WebAssembly, AudioWorklet and an AudioContext that has one', () => {
    expect(inAppSuppressionSupported(full)).toBe(true);
    expect(inAppSuppressionSupported({ ...full, WebAssembly: undefined })).toBe(false);
    expect(inAppSuppressionSupported({ ...full, AudioWorkletNode: undefined })).toBe(false);
    expect(inAppSuppressionSupported({ ...full, AudioContext: undefined })).toBe(false);
    expect(inAppSuppressionSupported({ ...full, AudioContext: class {} })).toBe(false);
    expect(inAppSuppressionSupported({})).toBe(false);
  });
});

describe('fallbackIsQuiet', () => {
  const processing = (noiseMode: AudioProcessing['noiseMode'], noiseModeChosen: boolean) => ({
    ...defaultAudioProcessing,
    noiseMode,
    noiseModeChosen,
  });

  it('is quiet only for the suppressor the default picked, never for a choice', () => {
    expect(fallbackIsQuiet(processing('strong', false), 'fastenhancer')).toBe(true);
    expect(fallbackIsQuiet(processing('strong', true), 'fastenhancer')).toBe(false);
    expect(fallbackIsQuiet(processing('enhanced', true), 'rnnoise')).toBe(false);
    expect(fallbackIsQuiet(processing('strong', false), 'rnnoise')).toBe(false);
    expect(fallbackIsQuiet(processing('standard', false), 'fastenhancer')).toBe(false);
  });
});

describe('captureConstraints', () => {
  const processing = (noiseMode: AudioProcessing['noiseMode']): AudioProcessing => ({
    echoCancellation: true,
    noiseMode,
    noiseModeChosen: true,
    autoGainControl: true,
  });

  it('asks the browser to suppress noise only in standard mode', () => {
    expect(captureConstraints(processing('off'), {})).toMatchObject({
      noiseSuppression: false,
      voiceIsolation: false,
    });
    expect(captureConstraints(processing('standard'), {})).toMatchObject({
      noiseSuppression: true,
      voiceIsolation: true,
    });
    for (const mode of ['enhanced', 'strong'] as const) {
      expect(captureConstraints(processing(mode), {})).toMatchObject({
        noiseSuppression: false,
        voiceIsolation: false,
      });
    }
  });

  it('leaves echo cancellation and gain control to their own switches', () => {
    for (const mode of ['off', 'standard', 'enhanced', 'strong'] as const) {
      expect(
        captureConstraints({ ...processing(mode), echoCancellation: false }, {}),
      ).toMatchObject({
        echoCancellation: false,
        autoGainControl: true,
      });
      expect(captureConstraints({ ...processing(mode), autoGainControl: false }, {})).toMatchObject(
        {
          echoCancellation: true,
          autoGainControl: false,
        },
      );
    }
  });

  it('captures the way standard would once the chosen suppressor has failed in this session', () => {
    const standard = {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
      autoGainControl: true,
    };
    expect(captureConstraints(processing('enhanced'), { rnnoise: 'no wasm' })).toEqual(standard);
    expect(captureConstraints(processing('strong'), { fastenhancer: 'no wasm' })).toEqual(standard);
    const both = { rnnoise: 'no wasm', fastenhancer: 'no wasm' };
    expect(captureConstraints(processing('off'), both).noiseSuppression).toBe(false);
    expect(captureConstraints(processing('standard'), both).noiseSuppression).toBe(true);
  });

  it('keeps one suppressor usable when only the other has failed', () => {
    expect(
      captureConstraints(processing('enhanced'), { fastenhancer: 'no wasm' }).noiseSuppression,
    ).toBe(false);
    expect(captureConstraints(processing('strong'), { rnnoise: 'no wasm' }).noiseSuppression).toBe(
      false,
    );
  });
});

describe('effectiveNoiseMode', () => {
  it('reports what is really running, not what was chosen', () => {
    expect(effectiveNoiseMode('enhanced', {})).toBe('enhanced');
    expect(effectiveNoiseMode('enhanced', { rnnoise: 'no wasm' })).toBe('standard');
    expect(effectiveNoiseMode('enhanced', { fastenhancer: 'no wasm' })).toBe('enhanced');
    expect(effectiveNoiseMode('strong', { fastenhancer: 'no wasm' })).toBe('standard');
    expect(effectiveNoiseMode('strong', { rnnoise: 'no wasm' })).toBe('strong');
    const both = { rnnoise: 'no wasm', fastenhancer: 'no wasm' };
    expect(effectiveNoiseMode('off', both)).toBe('off');
    expect(effectiveNoiseMode('standard', both)).toBe('standard');
  });
});

describe('sameCaptureConstraints', () => {
  it('is what decides whether the microphone has to be re-opened', () => {
    const base = {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
      autoGainControl: true,
    };
    expect(sameCaptureConstraints(base, { ...base })).toBe(true);
    expect(sameCaptureConstraints(base, { ...base, noiseSuppression: false })).toBe(false);
    expect(sameCaptureConstraints(base, { ...base, voiceIsolation: false })).toBe(false);
    expect(sameCaptureConstraints(base, { ...base, echoCancellation: false })).toBe(false);
    expect(sameCaptureConstraints(base, { ...base, autoGainControl: false })).toBe(false);
  });

  it('sees no change between off and the in-app modes, which need the same capture', () => {
    const off: AudioProcessing = {
      echoCancellation: true,
      noiseMode: 'off',
      noiseModeChosen: true,
      autoGainControl: true,
    };
    for (const mode of ['enhanced', 'strong'] as const) {
      expect(
        sameCaptureConstraints(
          captureConstraints(off, {}),
          captureConstraints({ ...off, noiseMode: mode }, {}),
        ),
      ).toBe(true);
    }
  });
});
