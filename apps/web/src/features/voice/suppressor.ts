import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import fastEnhancerWorkletUrl from 'fastenhancer-web/worklet/processor.js?url';
import type { LoadedModel } from 'fastenhancer-web';
import type { AudioProcessorOptions, LocalAudioTrack, Track, TrackProcessor } from 'livekit-client';
import type { InAppSuppressor } from './audio-processing';
import { onIOS } from './audio-route';
import { OverloadWatch } from './overload';

const SAMPLE_RATE = 48_000;

const FASTENHANCER_MODEL = 'base';
const FASTENHANCER_START_TIMEOUT_MS = 10_000;
const AUDIO_ENGINE_TIMEOUT_MS = 15_000;
const AUDIO_ENGINE_CLOSE_TIMEOUT_MS = 2_000;
const OVERLOAD_REASON = 'this computer could not keep up with it';

interface SuppressorNode {
  node: AudioWorkletNode;
  release: () => void;
  onOverload?: (listener: (engaged: boolean) => void) => void;
}

interface Engine {
  workletUrl: string;
  prepare: () => Promise<void>;
  createNode: (context: AudioContext) => Promise<SuppressorNode>;
  highPassHz: number | null;
}

function withinTime<T>(work: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function closeWithinTime(context: AudioContext): Promise<void> {
  if (context.state === 'closed') return Promise.resolve();
  return withinTime(
    context.close(),
    AUDIO_ENGINE_CLOSE_TIMEOUT_MS,
    () => 'the browser did not close the audio engine in time',
  ).catch(() => undefined);
}

function compiledOnce<T>(load: () => Promise<{ value: T; wasm: ArrayBuffer }>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load()
      .then(async ({ value, wasm }) => {
        await WebAssembly.compile(wasm);
        return value;
      })
      .catch((err: unknown) => {
        pending = null;
        throw err instanceof Error
          ? new Error(`the noise suppressor could not be loaded (${err.message})`)
          : new Error('the noise suppressor could not be loaded');
      });
    return pending;
  };
}

const rnnoiseBinary = compiledOnce(async () => {
  const { loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
  const binary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  return { value: binary, wasm: binary };
});

const fastEnhancerModel = compiledOnce(async () => {
  const { loadModel } = await import('fastenhancer-web');
  const model = await loadModel(FASTENHANCER_MODEL);
  return { value: model, wasm: model.wasmBytes };
});

interface FastEnhancerMessage {
  type?: string;
  message?: string;
  enabled?: boolean;
}

function startFastEnhancer(node: AudioWorkletNode, model: LoadedModel): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the noise model did not start in time')),
      FASTENHANCER_START_TIMEOUT_MS,
    );
    node.port.onmessage = (event: MessageEvent<FastEnhancerMessage>) => {
      if (event.data.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (event.data.type === 'error') {
        clearTimeout(timer);
        reject(new Error(event.data.message ?? 'the noise model did not start'));
      }
    };
    const wasmBytes = model.wasmBytes;
    const weightBytes = model.weightData;
    node.port.postMessage(
      {
        type: 'init',
        wasmBytes,
        weightBytes,
        exportMap: model.exportMap,
        modelSize: model.modelSizeId,
      },
      [wasmBytes, weightBytes],
    );
  });
}

const ENGINES: Record<InAppSuppressor, Engine> = {
  rnnoise: {
    workletUrl: rnnoiseWorkletUrl,
    prepare: async () => {
      await rnnoiseBinary();
    },
    createNode: async (context) => {
      const { RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
      const node = new RnnoiseWorkletNode(context, {
        maxChannels: 1,
        wasmBinary: await rnnoiseBinary(),
      });
      return { node, release: () => node.destroy() };
    },
    highPassHz: null,
  },
  fastenhancer: {
    workletUrl: fastEnhancerWorkletUrl,
    prepare: async () => {
      await fastEnhancerModel();
    },
    createNode: async (context) => {
      const model = await fastEnhancerModel();
      const node = new AudioWorkletNode(context, 'fastenhancer-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      await startFastEnhancer(node, model);
      return {
        node,
        release: () => node.port.postMessage({ type: 'destroy' }),
        onOverload: (listener) => {
          node.port.onmessage = (event: MessageEvent<FastEnhancerMessage>) => {
            if (event.data.type === 'auto_bypass') listener(event.data.enabled === true);
          };
        },
      };
    },
    highPassHz: 80,
  },
};

const WATCHDOG_INTERVAL_MS = 500;
const WATCHDOG_INPUT_PEAK = 0.02;
const WATCHDOG_STRIKES = 6;
const WATCHDOG_START_GRACE_MS = 5000;

export class SuppressorProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  readonly name: string;
  processedTrack?: MediaStreamTrack;

  private source: MediaStreamAudioSourceNode | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private strikes = 0;
  private alive = false;
  private destroyed = false;
  private reported = false;
  private resumeTried = false;
  private readonly overload = new OverloadWatch();

  private constructor(
    readonly engine: InAppSuppressor,
    readonly context: AudioContext,
    private readonly worklet: SuppressorNode,
    private readonly input: AudioNode,
    private readonly destination: MediaStreamAudioDestinationNode,
    private readonly inputProbe: AnalyserNode,
    private readonly outputProbe: AnalyserNode,
    private readonly onBroken: (reason: string, stoppedByPhone: boolean) => void,
  ) {
    this.name = `hostile-${engine}`;
  }

  static async create(
    engine: InAppSuppressor,
    onBroken: (reason: string, stoppedByPhone: boolean) => void,
  ): Promise<SuppressorProcessor> {
    const spec = ENGINES[engine];
    await spec.prepare();
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    try {
      await withinTime(
        context.audioWorklet.addModule(spec.workletUrl),
        AUDIO_ENGINE_TIMEOUT_MS,
        () => 'the browser did not load the noise suppressor in time',
      );
      if (context.state !== 'running') {
        const resumed = context.resume().catch(() => undefined);
        if (onIOS()) await resumed;
        else
          await withinTime(
            resumed,
            AUDIO_ENGINE_TIMEOUT_MS,
            () => 'the browser did not start the audio engine in time',
          );
      }
      if (context.state !== 'running') {
        throw new Error(`the browser kept the audio engine ${context.state}`);
      }
      const worklet = await spec.createNode(context);
      const node = worklet.node;
      node.channelCount = 1;
      node.channelCountMode = 'explicit';
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      node.connect(destination);
      let input: AudioNode = node;
      if (spec.highPassHz !== null) {
        const highPass = context.createBiquadFilter();
        highPass.type = 'highpass';
        highPass.frequency.value = spec.highPassHz;
        highPass.Q.value = Math.SQRT1_2;
        highPass.connect(node);
        input = highPass;
      }
      const inputProbe = context.createAnalyser();
      const outputProbe = context.createAnalyser();
      inputProbe.fftSize = 2048;
      outputProbe.fftSize = 2048;
      if (!onIOS()) {
        const silent = context.createGain();
        silent.gain.value = 0;
        inputProbe.connect(silent);
        outputProbe.connect(silent);
        silent.connect(context.destination);
      }
      node.connect(outputProbe);
      const processor = new SuppressorProcessor(
        engine,
        context,
        worklet,
        input,
        destination,
        inputProbe,
        outputProbe,
        onBroken,
      );
      processor.processedTrack = destination.stream.getAudioTracks()[0];
      if (!processor.processedTrack) throw new Error('the browser produced no processed track');
      context.addEventListener('statechange', () => void processor.handleStateChange());
      worklet.onOverload?.((engaged) => {
        const repeated = processor.overload.change(engaged, Date.now());
        if (repeated && !hiddenOnIOS()) processor.reportBroken(OVERLOAD_REASON);
      });
      return processor;
    } catch (err) {
      await closeWithinTime(context);
      throw err;
    }
  }

  init(opts: AudioProcessorOptions): Promise<void> {
    this.attach(opts.track);
    this.startWatchdog();
    return Promise.resolve();
  }

  restart(opts: AudioProcessorOptions): Promise<void> {
    if (!this.destroyed) this.attach(opts.track);
    return Promise.resolve();
  }

  private attach(track: MediaStreamTrack) {
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.input);
    this.source.connect(this.inputProbe);
    this.strikes = 0;
  }

  private async handleStateChange(): Promise<void> {
    if (this.destroyed || this.reported) return;
    const state = (): AudioContextState => this.context.state;
    if (state() === 'running') {
      this.resumeTried = false;
      return;
    }
    if (state() === 'closed') {
      this.reportBroken('the browser closed the audio engine');
      return;
    }
    if (onIOS()) {
      void this.context.resume().catch(() => undefined);
      return;
    }
    if (this.resumeTried) {
      this.reportBroken('the browser stopped the audio engine');
      return;
    }
    this.resumeTried = true;
    await withinTime(
      this.context.resume(),
      AUDIO_ENGINE_TIMEOUT_MS,
      () => 'resume timed out',
    ).catch(() => undefined);
    if (this.destroyed) return;
    if (state() !== 'running') this.reportBroken('the browser stopped the audio engine');
  }

  private startWatchdog() {
    if (this.watchdog !== null || this.destroyed) return;
    const input = new Float32Array(this.inputProbe.fftSize);
    const output = new Float32Array(this.outputProbe.fftSize);
    const startedAt = Date.now();
    let lastRenderTime = this.context.currentTime;
    let stalls = 0;
    this.watchdog = setInterval(() => {
      const renderTime = this.context.currentTime;
      if (onIOS() && this.context.state !== 'running') {
        void this.context.resume().catch(() => undefined);
      }
      if (hiddenOnIOS()) {
        stalls = 0;
        this.strikes = 0;
        this.overload.forgive(Date.now());
        lastRenderTime = renderTime;
        return;
      }
      stalls = renderTime > lastRenderTime ? 0 : stalls + 1;
      lastRenderTime = renderTime;
      if (stalls >= WATCHDOG_STRIKES) {
        this.reportBroken('the browser stopped rendering audio');
        return;
      }
      if (this.overload.stuck(Date.now())) {
        this.reportBroken(OVERLOAD_REASON);
        return;
      }
      this.inputProbe.getFloatTimeDomainData(input);
      this.outputProbe.getFloatTimeDomainData(output);
      const silentOut = peak(output) === 0;
      if (!this.alive) {
        if (silentOut) {
          if (Date.now() - startedAt < WATCHDOG_START_GRACE_MS) return;
        } else {
          this.alive = true;
        }
      }
      const quietIn = peak(input) < WATCHDOG_INPUT_PEAK;
      this.strikes = quietIn || !silentOut ? 0 : this.strikes + 1;
      if (this.strikes < WATCHDOG_STRIKES) return;
      this.reportBroken('it stopped passing audio through');
    }, WATCHDOG_INTERVAL_MS);
  }

  private reportBroken(reason: string) {
    if (this.destroyed || this.reported) return;
    this.reported = true;
    this.stopWatchdog();
    this.onBroken(reason, onIOS() && this.context.state !== 'running');
  }

  private stopWatchdog() {
    if (this.watchdog === null) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopWatchdog();
    this.source?.disconnect();
    this.source = null;
    this.input.disconnect();
    try {
      this.worklet.release();
    } catch {}
    this.worklet.node.disconnect();
    this.destination.disconnect();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    await closeWithinTime(this.context);
  }
}

function hiddenOnIOS(): boolean {
  return onIOS() && document.visibilityState === 'hidden';
}

function peak(samples: Float32Array): number {
  let max = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

export async function attachNoiseSuppressor(
  engine: InAppSuppressor,
  track: LocalAudioTrack,
  onBroken: (reason: string, stoppedByPhone: boolean) => void,
  stillWanted: () => boolean = () => true,
): Promise<SuppressorProcessor | null> {
  const processor = await SuppressorProcessor.create(engine, onBroken);
  if (!stillWanted()) {
    await processor.destroy();
    return null;
  }
  try {
    track.setAudioContext(processor.context);
    await track.setProcessor(processor);
  } catch (err) {
    await processor.destroy();
    throw err;
  }
  if (!stillWanted()) {
    await track.stopProcessor().catch(() => undefined);
    await processor.destroy();
    return null;
  }
  return processor;
}
