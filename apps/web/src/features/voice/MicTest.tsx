import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LocalAudioTrack } from 'livekit-client';
import { Button, Banner, Switch, cx } from '../../components/ui';
import { captureConstraints, effectiveNoiseMode, suppressorFor } from './audio-processing';
import { voice } from './controller';
import { loadLiveKit } from './livekit';
import { attachNoiseSuppressor, type SuppressorProcessor } from './suppressor';
import { useVoice } from './store';
import styles from './voice.module.scss';

export function MicTest() {
  const inputDeviceId = useVoice((s) => s.inputDeviceId);
  const processing = useVoice((s) => s.processing);
  const suppressorFailures = useVoice((s) => s.suppressorFailures);
  const inCall = useVoice((s) => s.status !== 'idle');
  const outputDeviceId = useVoice((s) => s.outputDeviceId);
  const mutedInCall = useVoice((s) => s.status !== 'idle' && (s.micMuted || s.deafened));
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [hearMyself, setHearMyself] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current++;
      cleanup.current?.();
    },
    [],
  );

  const restartIfRunning = useEffectEvent(() => {
    if (!running) return;
    void start();
  });
  useEffect(() => {
    restartIfRunning();
  }, [
    inputDeviceId,
    outputDeviceId,
    processing,
    suppressorFailures,
    inCall,
    mutedInCall,
    hearMyself,
  ]);

  async function start() {
    cleanup.current?.();
    const myGen = ++generation.current;
    const stale = () => generation.current !== myGen;
    setError(null);
    setStarting(true);
    let ownTrack: LocalAudioTrack | null = null;
    let ownProcessor: SuppressorProcessor | null = null;
    let stopAnalyser: (() => Promise<void>) | null = null;
    let raf = 0;
    let audioEl: HTMLAudioElement | null = null;
    const release = () => {
      cancelAnimationFrame(raf);
      void stopAnalyser?.();
      if (audioEl) {
        audioEl.pause();
        (audioEl.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
        audioEl.srcObject = null;
      }
      ownTrack?.stop();
      void ownProcessor?.destroy();
    };
    try {
      const { createAudioAnalyser, createLocalAudioTrack } = await loadLiveKit();
      if (stale()) {
        release();
        return;
      }
      const suppressor = suppressorFor(
        effectiveNoiseMode(processing.noiseMode, suppressorFailures),
      );
      let track = voice().getMicTrack();
      if (!track) {
        ownTrack = track = await createLocalAudioTrack({
          deviceId: inputDeviceId,
          ...captureConstraints(processing, suppressorFailures),
        });
        if (stale()) {
          release();
          return;
        }
        if (suppressor) {
          try {
            ownProcessor = await attachNoiseSuppressor(
              suppressor,
              track,
              (reason) => voice().noteSuppressorFailed(suppressor, reason),
              () => !stale(),
            );
          } catch (err) {
            voice().noteSuppressorFailed(
              suppressor,
              err instanceof Error ? err.message : String(err),
            );
            release();
            return;
          }
          if (!ownProcessor) {
            release();
            return;
          }
        }
      }
      if (stale()) {
        release();
        return;
      }
      const analyser = createAudioAnalyser(track, { cloneTrack: true });
      stopAnalyser = analyser.cleanup;
      const tick = () => {
        setLevel(analyser.calculateVolume());
        raf = requestAnimationFrame(tick);
      };
      tick();
      if (hearMyself && !mutedInCall && track.mediaStreamTrack) {
        audioEl = new Audio();
        audioEl.srcObject = new MediaStream([track.mediaStreamTrack.clone()]);
        if (outputDeviceId !== 'default' && 'setSinkId' in audioEl) {
          await (audioEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
            .setSinkId(outputDeviceId)
            .catch(() => undefined);
          if (stale()) {
            release();
            return;
          }
        }
        let playbackError: unknown = null;
        await audioEl.play().catch((err: unknown) => {
          playbackError = err;
        });
        if (stale()) {
          release();
          return;
        }
        if (playbackError) {
          setError(
            `The microphone works, but it could not be played back: ${
              playbackError instanceof Error ? playbackError.message : 'playback was refused'
            }`,
          );
        }
      }
      cleanup.current = () => {
        release();
        cleanup.current = null;
        setLevel(0);
      };
      setRunning(true);
    } catch (err) {
      release();
      if (stale()) return;
      setError(err instanceof Error ? err.message : 'Could not open the microphone.');
      setRunning(false);
    } finally {
      if (!stale()) setStarting(false);
    }
  }

  function stop() {
    generation.current++;
    cleanup.current?.();
    setRunning(false);
    setStarting(false);
  }

  const caption = running
    ? mutedInCall
      ? 'Your microphone is muted, so nothing is measured. Unmute to test it.'
      : level > 0.02
        ? 'Picking up sound'
        : 'Speak to see the level move'
    : starting
      ? 'Opening the microphone…'
      : 'Not testing';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      {error && <Banner kind="error">{error}</Banner>}
      <div className={cx(styles.meter, (!running || mutedInCall) && styles.meterIdle)} aria-hidden>
        <div
          className={styles.meterFill}
          style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <Button small busy={starting && !running} onClick={() => (running ? stop() : void start())}>
          {running ? 'Stop test' : 'Test microphone'}
        </Button>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }} role="status">
          {caption}
        </span>
      </div>
      <Switch
        checked={hearMyself}
        onChange={setHearMyself}
        label="Play my microphone back to me"
        description="Use headphones, or you will hear an echo."
      />
    </div>
  );
}
