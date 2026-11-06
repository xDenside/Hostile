import type {
  ConnectionQuality,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteVideoTrack,
  Room,
  Track,
} from 'livekit-client';
import { SCREEN_SHARE_PRESETS, type ScreenSharePresetId } from '@hostile/shared';
import { ApiError, endpoints, errorMessage } from '../../api/client';
import { voiceServerUrl } from '../../tunnel/net';
import { platform } from '../../platform';
import { emitVoiceSelfState, onRealtimeConnect } from '../../realtime/socket';
import { useCommunity } from '../../stores/community';
import { toast } from '../../stores/ui';
import {
  captureConstraints,
  effectiveNoiseMode,
  fallbackIsQuiet,
  sameCaptureConstraints,
  SUPPRESSOR_MODE_NAMES,
  suppressorFor,
  type AudioProcessing,
  type CaptureConstraints,
  type InAppSuppressor,
} from './audio-processing';
import { effectiveVolume, maxVolume, mutedForMe, onIOS } from './audio-route';
import { audiencesOf, cueViewerJoin, viewerPairsAdded, type Audiences } from './cue-rules';
import {
  advanceDuck,
  initialDuckState,
  rms,
  speakersThatDuck,
  SPEECH_RMS,
  type DuckState,
} from './ducking';
import { loadLiveKit, preloadLiveKit, supportsOutputSelection, type LiveKit } from './livekit';
import { attachNoiseSuppressor, type SuppressorProcessor } from './suppressor';
import { playCue, preloadCues } from './sounds';
import { SerialQueue, suppressorStillWanted } from './switching';
import { isMicError, useVoice, type RemoteState, type VoiceError, type VoiceState } from './store';

const set = (patch: Partial<VoiceState> | ((s: VoiceState) => Partial<VoiceState>)) =>
  useVoice.setState(patch);
const get = () => useVoice.getState();

let lk: LiveKit;

const LEAVE_CUE_DELAY_MS = 300;
const VIEWER_REJOIN_GRACE_MS = 15_000;
const AUTO_VIEW_QUIET_MS = 2000;
const DUCK_TICK_MS = 40;

interface MicMeter {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  frame: Float32Array<ArrayBuffer>;
}

function voiceError(kind: VoiceError['kind'], message: string): VoiceError {
  return { kind, message };
}

function mapTokenError(err: unknown): VoiceError {
  if (err instanceof ApiError) {
    if (err.status === 401)
      return voiceError('auth', 'Your session has ended. Reload to use voice.');
    if (err.code === 'account_disabled')
      return voiceError('forbidden', 'This account has been disabled.');
    if (err.status === 403) return voiceError('forbidden', "You can't join this voice channel.");
    if (err.status === 404) return voiceError('forbidden', 'This voice channel no longer exists.');
    if (err.status === 503) return voiceError('unavailable', err.message);
    if (err.status === 429)
      return voiceError('unknown', 'Too many join attempts. Wait a moment and try again.');
    if (err.isNetwork) return voiceError('unavailable', 'Cannot reach the server to join voice.');
  }
  return voiceError('unknown', errorMessage(err));
}

function mapDisconnectReason(reason: DisconnectReason | undefined): VoiceError | null {
  switch (reason) {
    case lk.DisconnectReason.CLIENT_INITIATED:
      return null;
    case lk.DisconnectReason.DUPLICATE_IDENTITY:
      return voiceError(
        'duplicate',
        'You joined voice from another window or device, so this one left the call.',
      );
    case lk.DisconnectReason.PARTICIPANT_REMOVED:
      return voiceError('removed', 'The server removed you from the voice channel.');
    case lk.DisconnectReason.ROOM_DELETED:
    case lk.DisconnectReason.ROOM_CLOSED:
      return voiceError('room-closed', 'This voice channel was closed.');
    case lk.DisconnectReason.SERVER_SHUTDOWN:
      return voiceError('disconnected', 'The voice server shut down.');
    case lk.DisconnectReason.USER_REJECTED:
      return voiceError('auth', 'The voice server rejected the join token.');
    default:
      return voiceError(
        'disconnected',
        'Lost the connection to the voice server and could not recover it.',
      );
  }
}

function mapConnectError(err: unknown, url: string): VoiceError | null {
  if (err instanceof lk.ConnectionError) {
    switch (err.reason) {
      case lk.ConnectionErrorReason.Cancelled:
        return null;
      case lk.ConnectionErrorReason.NotAllowed:
        return voiceError(
          'auth',
          'The voice server rejected the join token. It may have expired, or this computer’s clock is wrong.',
        );
      case lk.ConnectionErrorReason.LeaveRequest:
        return mapDisconnectReason(err.context as DisconnectReason);
      case lk.ConnectionErrorReason.InternalError:
        if (/pc connection|peer ?connection|ice/i.test(err.message)) {
          return voiceError(
            'media',
            'Reached the voice server, but audio could not flow (no working UDP/TCP/TURN path). See Settings → Diagnostics.',
          );
        }
        return voiceError('signal', `The voice server reported an error: ${err.message}`);
      default:
        return voiceError(
          'signal',
          `Cannot reach the voice server at ${url}. Check that it is running and that this address is reachable.`,
        );
    }
  }
  return voiceError('unknown', errorMessage(err));
}

function mapMicError(err: unknown): VoiceError {
  const desktopMac = platform().kind === 'desktop' && navigator.userAgent.includes('Mac');
  switch (lk.MediaDeviceFailure.getFailure(err)) {
    case lk.MediaDeviceFailure.PermissionDenied:
      return voiceError(
        'mic-denied',
        desktopMac
          ? 'Microphone access is blocked. Allow Hostile in System Settings → Privacy & Security → Microphone. You can still listen.'
          : 'Microphone access was denied. Allow it in your browser’s site settings. You can still listen.',
      );
    case lk.MediaDeviceFailure.NotFound:
      return voiceError(
        'mic-missing',
        'No microphone was found. Connect one and choose it in Settings → Voice. You can still listen.',
      );
    case lk.MediaDeviceFailure.DeviceInUse:
      return voiceError(
        'mic-busy',
        'The microphone is in use by another application or could not be started. You can still listen.',
      );
    default:
      return voiceError('mic-missing', `Could not start the microphone: ${errorMessage(err)}`);
  }
}

async function microphoneAllowed(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

function qualityName(q: ConnectionQuality): RemoteState['quality'] {
  switch (q) {
    case lk.ConnectionQuality.Excellent:
      return 'excellent';
    case lk.ConnectionQuality.Good:
      return 'good';
    case lk.ConnectionQuality.Poor:
      return 'poor';
    case lk.ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
}

export interface VoiceDiagnostics {
  connectionState: string;
  serverUrl: string | null;
  candidateType: string | null;
  protocol: string | null;
  localAudio: { bytesSent: number; packetsSent: number } | null;
  noiseSuppression: { mode: string; processor: string | null; failures: string[] };
  remotes: {
    userId: string;
    audioBytesReceived: number | null;
    audioSamplesReceived: number | null;
    audioEnergy: number | null;
    audioLevel: number;
    screenFramesDecoded: number | null;
    screenSize: string | null;
    screenAudioBytesReceived: number | null;
    screenAudioVolume: number | null;
  }[];
}

class VoiceController {
  private room: Room | null = null;
  private joinSeq = 0;
  private leaving = false;
  private micTrack: LocalAudioTrack | null = null;
  private micProcessor: SuppressorProcessor | null = null;
  private micConstraints: CaptureConstraints | null = null;
  private readonly processingQueue = new SerialQueue((busy) => set({ processingBusy: busy }));
  private readonly audioSink: HTMLDivElement;
  private serverUrl: string | null = null;
  private trackListeners = new Set<() => void>();
  private offRealtime: (() => void) | null = null;
  private cuedParticipants = new Set<string>();
  private cuedSharers = new Set<string>();
  private readonly watchCounts = new Map<string, number>();
  private watched: string[] = [];
  private watchFlushQueued = false;
  private audiences: { channelId: string; map: Audiences } | null = null;
  private readonly viewerLeftAt = new Map<string, number>();
  private connectedAt = 0;
  private readonly shareCuedAt = new Map<string, number>();
  private duckTimer: number | undefined;
  private duck: DuckState | null = null;
  private meterContext: AudioContext | null = null;
  private readonly micMeters = new Map<string, MicMeter>();

  constructor() {
    this.audioSink = document.createElement('div');
    this.audioSink.id = 'hostile-audio-sink';
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
    set({ outputSelectionSupported: supportsOutputSelection() });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
    useCommunity.subscribe((s, prev) => {
      if (s.voice.rooms !== prev.voice.rooms) this.checkAudiences();
    });
    useVoice.subscribe((s, prev) => {
      if (
        s.streamDucking !== prev.streamDucking ||
        s.remotes !== prev.remotes ||
        s.status !== prev.status
      ) {
        this.syncDucking();
      }
    });
  }

  preload(): void {
    preloadLiveKit();
  }

  async join(channelId: string): Promise<void> {
    const current = get();
    if (current.channelId === channelId && current.status !== 'idle') return;
    const seq = ++this.joinSeq;
    preloadCues();
    if (this.room) await this.teardown();
    if (seq !== this.joinSeq) return;

    set({
      status: 'requesting-token',
      channelId,
      error: null,
      remotes: {},
      connectionQuality: 'unknown',
      speaking: {},
      localShare: null,
      micPublished: false,
      audioPlaybackBlocked: false,
    });

    const library = loadLiveKit();
    library.catch(() => undefined);
    const held = await this.askForMicrophone();
    if (held.refusal !== null) this.micRefusal = { seq, err: held.refusal };
    let room: Room;
    try {
      if (seq !== this.joinSeq) return;
      let token;
      try {
        const hosting = platform().desktop?.hosting;
        for (let tries = 0; hosting && tries < 60; tries++) {
          const { state } = (await hosting.status()).parts.media;
          if (state !== 'starting' && state !== 'restarting') break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        token = await endpoints.voiceToken(channelId);
      } catch (err) {
        if (seq !== this.joinSeq) return;
        this.resetIdle(mapTokenError(err));
        return;
      }
      if (seq !== this.joinSeq) return;
      try {
        lk = await library;
      } catch (err) {
        if (seq === this.joinSeq) this.resetIdle(voiceError('unavailable', errorMessage(err)));
        return;
      }
      if (seq !== this.joinSeq) return;
      const s = get();
      room = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: !onIOS(),
        disconnectOnPageLeave: true,
        stopLocalTrackOnUnpublish: true,
        audioCaptureDefaults: {
          deviceId: s.inputDeviceId,
          ...captureConstraints(s.processing, s.suppressorFailures),
        },
        audioOutput: { deviceId: s.outputDeviceId },
        publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false },
      });
      this.room = room;
      this.serverUrl = token.url;
      this.leaving = false;
      this.bindRoomEvents(room);
      set({ status: 'connecting' });

      try {
        await room.connect(voiceServerUrl(token.url), token.token, { autoSubscribe: true });
      } catch (err) {
        if (seq !== this.joinSeq) return;
        const mapped = mapConnectError(err, token.url);
        await this.teardown();
        if (seq === this.joinSeq) this.resetIdle(mapped);
        return;
      }
      if (seq !== this.joinSeq) {
        void room.disconnect();
        return;
      }
    } finally {
      for (const track of held.stream?.getTracks() ?? []) track.stop();
    }

    set({ status: 'connected', audioPlaybackBlocked: !room.canPlaybackAudio });
    this.connectedAt = performance.now();
    this.baselineCues(room);
    for (const p of room.remoteParticipants.values()) this.updateRemote(p);
    this.applyVolumes();
    await this.publishMicrophone(seq);
    if (seq === this.joinSeq) playCue('join');
    this.reportSelfState();
    this.offRealtime?.();
    this.offRealtime = onRealtimeConnect(() => this.reportSelfState());
    void this.refreshDevices();
  }

  async leave(): Promise<void> {
    if (get().status !== 'idle') playCue('leave');
    const seq = ++this.joinSeq;
    await this.teardown();
    if (seq === this.joinSeq) this.resetIdle(null);
  }

  private resetIdle(error: VoiceError | null) {
    set({
      status: 'idle',
      channelId: null,
      error,
      remotes: {},
      connectionQuality: 'unknown',
      speaking: {},
      localShare: null,
      shareStarting: false,
      micPublished: false,
      audioPlaybackBlocked: false,
    });
    this.reportSelfState();
    this.notifyTracks();
  }

  private async teardown() {
    const room = this.room;
    const processor = this.micProcessor;
    const audio = Array.from(this.audioSink.children) as HTMLMediaElement[];
    this.room = null;
    this.micTrack = null;
    this.micProcessor = null;
    this.micConstraints = null;
    this.offRealtime?.();
    this.offRealtime = null;
    await processor?.destroy();
    if (!room) return;
    this.leaving = true;
    try {
      await room.disconnect(true);
    } catch {}
    for (const el of audio) {
      el.srcObject = null;
      el.remove();
    }
    this.notifyTracks();
  }

  private effectiveMuted(): boolean {
    const s = get();
    return s.micMuted || s.deafened;
  }

  private micRefusal: { seq: number; err: unknown } | null = null;

  private async askForMicrophone(): Promise<{ stream: MediaStream | null; refusal: unknown }> {
    const skipped = { stream: null, refusal: null };
    if (platform().kind === 'desktop') return skipped;
    const media = navigator.mediaDevices;
    if (typeof media?.getUserMedia !== 'function') return skipped;
    if (await microphoneAllowed()) return skipped;
    const deviceId = get().inputDeviceId;
    try {
      const stream = await media.getUserMedia({
        audio: deviceId && deviceId !== 'default' ? { deviceId } : true,
      });
      return { stream, refusal: null };
    } catch (err) {
      const refused =
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      return { stream: null, refusal: refused ? err : null };
    }
  }

  private micPublishing: { seq: number; done: Promise<void> } | null = null;

  private publishMicrophone(seq: number): Promise<void> {
    if (this.micPublishing?.seq === seq) return this.micPublishing.done;
    const done: Promise<void> = this.doPublishMicrophone(seq).finally(() => {
      if (this.micPublishing?.done === done) this.micPublishing = null;
    });
    this.micPublishing = { seq, done };
    return done;
  }

  private async doPublishMicrophone(seq: number): Promise<void> {
    const room = this.room;
    if (!room) return;
    const existing = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone);
    if (existing?.track) {
      await room.localParticipant.unpublishTrack(existing.track, true).catch(() => undefined);
    }
    const stale = this.micProcessor;
    this.micProcessor = null;
    this.micConstraints = null;
    await stale?.destroy();
    const refusal = this.micRefusal;
    this.micRefusal = null;
    if (refusal?.seq === seq) {
      if (seq === this.joinSeq && this.room === room)
        set({ micPublished: false, error: mapMicError(refusal.err) });
      return;
    }
    const s = get();
    const constraints = captureConstraints(s.processing, s.suppressorFailures);
    let track: LocalAudioTrack;
    try {
      track = await lk.createLocalAudioTrack({ deviceId: s.inputDeviceId, ...constraints });
    } catch (err) {
      if (seq === this.joinSeq && this.room === room)
        set({ micPublished: false, error: mapMicError(err) });
      return;
    }
    if (seq !== this.joinSeq || this.room !== room) {
      track.stop();
      return;
    }
    this.micConstraints = constraints;
    let ownProcessor: SuppressorProcessor | null = null;
    const dropOwnProcessor = async () => {
      if (this.micProcessor === ownProcessor) this.micProcessor = null;
      await ownProcessor?.destroy();
    };
    let capture = track.mediaStreamTrack;
    if (this.effectiveMuted()) await track.mute();
    const suppressor = this.wantedSuppressor();
    if (suppressor) {
      const outcome = await this.attachSuppressor(track, suppressor, () =>
        suppressorStillWanted({
          token: seq,
          newestToken: this.joinSeq,
          room,
          roomNow: this.room,
          track,
          trackNow: track,
          suppressor,
          suppressorNow: this.wantedSuppressor(),
        }),
      );
      if (outcome === 'attached') ownProcessor = this.micProcessor;
      if (outcome === 'fallback' || outcome === 'no-microphone') capture = track.mediaStreamTrack;
      if (outcome === 'no-microphone') {
        await dropOwnProcessor();
        track.stop();
        return;
      }
    }
    if (seq !== this.joinSeq || this.room !== room) {
      await dropOwnProcessor();
      track.stop();
      return;
    }
    if (capture.readyState !== 'live') {
      await dropOwnProcessor();
      track.stop();
      if (seq === this.joinSeq && this.room === room) {
        set({
          micPublished: false,
          error: voiceError(
            'mic-missing',
            'The microphone stopped when it was re-opened. Use “Try again” to start it.',
          ),
        });
      }
      return;
    }
    try {
      await room.localParticipant.publishTrack(track, { source: lk.Track.Source.Microphone });
    } catch (err) {
      await dropOwnProcessor();
      track.stop();
      if (seq === this.joinSeq && this.room === room) {
        set({
          micPublished: false,
          error: voiceError('unknown', `Could not publish the microphone: ${errorMessage(err)}`),
        });
      }
      return;
    }
    if (seq !== this.joinSeq || this.room !== room) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
      await dropOwnProcessor();
      return;
    }
    this.micTrack = track;
    track.on(lk.TrackEvent.Restarted, () => void this.enforceMicState());
    set({ micPublished: true, error: null });
    await this.enforceMicState();
  }

  async retryMicrophone(): Promise<void> {
    if (!this.room) return;
    if (this.micPublishing?.seq === this.joinSeq) return this.micPublishing.done;
    if (
      get().micPublished &&
      this.room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track
    ) {
      if (isMicError(get().error)) set({ error: null });
      return;
    }
    await this.publishMicrophone(this.joinSeq);
  }

  private wantedSuppressor(): InAppSuppressor | null {
    const s = get();
    return suppressorFor(effectiveNoiseMode(s.processing.noiseMode, s.suppressorFailures));
  }

  noteSuppressorFailed(suppressor: InAppSuppressor, reason: string): void {
    const { suppressorFailures: failures, processing } = get();
    if (failures[suppressor]) return;
    set({ suppressorFailures: { ...failures, [suppressor]: reason } });
    if (fallbackIsQuiet(processing, suppressor)) return;
    toast(
      `${SUPPRESSOR_MODE_NAMES[suppressor]} noise suppression could not start (${reason}), so the standard one is being used instead for this session.`,
      'error',
      12_000,
    );
  }

  private async attachSuppressor(
    track: LocalAudioTrack,
    suppressor: InAppSuppressor,
    stillWanted: () => boolean,
  ): Promise<'attached' | 'abandoned' | 'fallback' | 'no-microphone'> {
    try {
      const processor = await attachNoiseSuppressor(
        suppressor,
        track,
        (reason, stoppedByPhone) => {
          void this.suppressorBroke(reason, stoppedByPhone);
        },
        stillWanted,
      );
      if (!processor) return 'abandoned';
      this.micProcessor = processor;
      return 'attached';
    } catch (err) {
      this.noteSuppressorFailed(suppressor, errorMessage(err));
      if (!stillWanted()) return 'abandoned';
      this.micProcessor = null;
      const reopened = await this.reopenCapture(
        track,
        captureConstraints(get().processing, get().suppressorFailures),
      );
      return reopened ? 'fallback' : 'no-microphone';
    }
  }

  private async reopenCapture(
    track: LocalAudioTrack,
    constraints: CaptureConstraints,
  ): Promise<boolean> {
    try {
      await track.restartTrack({ deviceId: get().inputDeviceId, ...constraints });
      this.micConstraints = constraints;
      return true;
    } catch (err) {
      this.micConstraints = null;
      if (this.micTrack === track) set({ micPublished: false, error: mapMicError(err) });
      return false;
    }
  }

  private async suppressorBroke(reason: string, stoppedByPhone: boolean): Promise<void> {
    const processor = this.micProcessor;
    if (!processor) return;
    if (!stoppedByPhone) this.noteSuppressorFailed(processor.engine, reason);
    this.micProcessor = null;
    await this.micTrack?.stopProcessor().catch(() => undefined);
    await processor.destroy();
    await this.processingQueue.run((token) => this.applyProcessing(token));
  }

  private async enforceMicState(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const publications = [...room.localParticipant.trackPublications.values()].filter(
      (p) => p.source === lk.Track.Source.Microphone,
    );
    const live = publications.filter((p) => p.track);
    if (live.length === 0) {
      if (get().micPublished) {
        set({
          micPublished: false,
          error: voiceError(
            'mic-missing',
            'Your microphone stopped being sent after the connection came back. Use “Try again” to start it.',
          ),
        });
      }
      return;
    }
    const muted = this.effectiveMuted();
    for (const pub of live) {
      if (muted) {
        if (!pub.isMuted) await pub.mute();
        const mst = pub.track?.mediaStreamTrack;
        if (mst) mst.enabled = false;
      } else {
        if (pub.isMuted) await pub.unmute();
        const mst = pub.track?.mediaStreamTrack;
        if (mst && !mst.enabled) mst.enabled = true;
      }
    }
  }

  setMicMuted(muted: boolean) {
    if (get().micMuted === muted && !(get().deafened && !muted)) return;
    const undeafen = !muted && get().deafened;
    if (undeafen) {
      set({ deafened: false });
      this.applyVolumes();
    }
    set({ micMuted: muted });
    playCue(undeafen ? 'undeafen' : muted ? 'mute' : 'unmute');
    void this.enforceMicState();
    this.reportSelfState();
  }

  toggleMute() {
    const s = get();
    this.setMicMuted(!(s.micMuted || s.deafened));
  }

  setDeafened(deafened: boolean) {
    if (get().deafened === deafened) return;
    set({ deafened });
    playCue(deafened ? 'deafen' : 'undeafen');
    this.applyVolumes();
    void this.enforceMicState();
    this.reportSelfState();
  }

  toggleDeafen() {
    this.setDeafened(!get().deafened);
  }

  private reportSelfState() {
    const s = get();
    const inCall = s.status !== 'idle';
    emitVoiceSelfState({
      channelId: inCall ? s.channelId : null,
      muted: this.effectiveMuted(),
      deafened: s.deafened,
      watching: inCall ? this.watched : [],
    });
  }

  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const input = all.filter((d) => d.kind === 'audioinput');
      const output = all.filter((d) => d.kind === 'audiooutput');
      set({ devices: { input, output } });
      const s = get();
      if (
        s.inputDeviceId !== 'default' &&
        input.length &&
        !input.some((d) => d.deviceId === s.inputDeviceId)
      ) {
        await this.setInputDevice('default');
        toast('Your microphone was disconnected; switched to the default device.', 'info');
      }
      if (
        s.outputDeviceId !== 'default' &&
        output.length &&
        !output.some((d) => d.deviceId === s.outputDeviceId)
      ) {
        await this.setOutputDevice('default');
      }
    } catch {}
  }

  async setInputDevice(deviceId: string): Promise<void> {
    set({ inputDeviceId: deviceId });
    const room = this.room;
    if (!room) return;
    if (!get().micPublished) {
      await this.retryMicrophone();
      return;
    }
    try {
      await room.switchActiveDevice('audioinput', deviceId, deviceId !== 'default');
    } catch (err) {
      set({ error: mapMicError(err) });
    }
    await this.enforceMicState();
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    set({ outputDeviceId: deviceId });
    const room = this.room;
    if (!room) return;
    try {
      await room.switchActiveDevice('audiooutput', deviceId);
    } catch (err) {
      toast(`Could not switch the output device: ${errorMessage(err)}`, 'error');
    }
  }

  async setProcessing(processing: AudioProcessing): Promise<void> {
    set({ processing });
    await this.processingQueue.run((token) => this.applyProcessing(token));
  }

  private async applyProcessing(token: number): Promise<void> {
    await this.micPublishing?.done.catch(() => undefined);
    const room = this.room;
    const track = this.micTrack;
    if (!room || !track) return;
    const current = () =>
      this.processingQueue.isNewest(token) && this.room === room && this.micTrack === track;
    if (!current()) return;
    const s = get();
    const wanted = this.wantedSuppressor();
    const constraints = captureConstraints(s.processing, s.suppressorFailures);

    if (this.micProcessor && this.micProcessor.engine !== wanted) {
      const processor = this.micProcessor;
      this.micProcessor = null;
      await track.stopProcessor().catch(() => undefined);
      await processor.destroy();
      if (!current()) return;
    }
    if (!this.micConstraints || !sameCaptureConstraints(this.micConstraints, constraints)) {
      if (!(await this.reopenCapture(track, constraints))) return;
      if (!current()) return;
    }
    if (wanted && !this.micProcessor) {
      const outcome = await this.attachSuppressor(track, wanted, () =>
        suppressorStillWanted({
          token,
          newestToken: this.processingQueue.newestToken,
          room,
          roomNow: this.room,
          track,
          trackNow: this.micTrack,
          suppressor: wanted,
          suppressorNow: this.wantedSuppressor(),
        }),
      );
      if (outcome === 'no-microphone') return;
      if (!current()) return;
    }
    await this.enforceMicState();
  }

  getMicTrack(): LocalAudioTrack | null {
    return this.micTrack;
  }

  setParticipantVolume(userId: string, volume: number) {
    set((s) => ({ volumes: { ...s.volumes, [userId]: volume } }));
    this.applyVolumes();
  }

  setStreamVolume(userId: string, volume: number) {
    set((s) => ({ streamVolumes: { ...s.streamVolumes, [userId]: volume } }));
    this.applyVolumes();
  }

  setLocalMute(userId: string, muted: boolean) {
    set((s) => {
      const localMutes = { ...s.localMutes };
      if (muted) localMutes[userId] = true;
      else delete localMutes[userId];
      if (muted || !mutedForMe(false, s.volumes[userId])) return { localMutes };
      const volumes = { ...s.volumes };
      delete volumes[userId];
      return { localMutes, volumes };
    });
    this.applyVolumes();
  }

  private applyVolumes() {
    const room = this.room;
    if (!room) return;
    const s = get();
    const duckGain = this.duck?.gain ?? 1;
    for (const p of room.remoteParticipants.values()) {
      this.setLevel(
        p,
        lk.Track.Source.Microphone,
        s.deafened || mutedForMe(!!s.localMutes[p.identity], s.volumes[p.identity])
          ? 0
          : effectiveVolume(s.volumes[p.identity] ?? 1),
      );
      this.setLevel(
        p,
        lk.Track.Source.ScreenShareAudio,
        s.deafened ? 0 : effectiveVolume(s.streamVolumes[p.identity] ?? 1) * duckGain,
      );
    }
  }

  private setLevel(
    p: RemoteParticipant,
    source: Track.Source.Microphone | Track.Source.ScreenShareAudio,
    level: number,
  ) {
    p.setVolume(level, source);
    if (!onIOS()) return;
    const track = p.getTrackPublication(source)?.track;
    if (track) track.mediaStreamTrack.enabled = level > 0 && !track.isMuted;
  }

  private syncDucking() {
    const s = get();
    const wanted =
      s.streamDucking &&
      maxVolume() > 0 &&
      s.status !== 'idle' &&
      Object.values(s.remotes).some((r) => r.screenShareAudio);
    if (wanted === (this.duckTimer !== undefined)) return;
    if (wanted) {
      this.duck = initialDuckState(performance.now());
      this.duckTimer = window.setInterval(() => this.tickDucking(), DUCK_TICK_MS);
      return;
    }
    clearInterval(this.duckTimer);
    this.duckTimer = undefined;
    this.duck = null;
    for (const id of [...this.micMeters.keys()]) this.dropMeter(id);
    void this.meterContext?.close().catch(() => undefined);
    this.meterContext = null;
    if (s.duckingNow) set({ duckingNow: false });
    this.applyVolumes();
  }

  private dropMeter(userId: string) {
    const meter = this.micMeters.get(userId);
    if (!meter) return;
    meter.source.disconnect();
    this.micMeters.delete(userId);
  }

  private measureSpeakers(room: Room): Set<string> {
    const speakers = new Set(Object.keys(get().speaking));
    try {
      this.readMeters(room, speakers);
    } catch {}
    return speakers;
  }

  private readMeters(room: Room, speakers: Set<string>) {
    const ctx = (this.meterContext ??= new AudioContext({ latencyHint: 'playback' }));
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    for (const id of [...this.micMeters.keys()]) {
      if (!room.remoteParticipants.has(id)) this.dropMeter(id);
    }
    for (const p of room.remoteParticipants.values()) {
      const track = p.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (this.micMeters.get(p.identity)?.track !== track) this.dropMeter(p.identity);
      if (!track) continue;
      let meter = this.micMeters.get(p.identity);
      if (!meter) {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        meter = { track, source, analyser, frame: new Float32Array(analyser.fftSize) };
        this.micMeters.set(p.identity, meter);
      }
      meter.analyser.getFloatTimeDomainData(meter.frame);
      if (rms(meter.frame) >= SPEECH_RMS) speakers.add(p.identity);
    }
  }

  private tickDucking() {
    const room = this.room;
    const previous = this.duck;
    if (!room || !previous) return;
    const s = get();
    const duckers = speakersThatDuck(
      this.measureSpeakers(room),
      room.localParticipant.identity,
      (id) => !!s.localMutes[id] || s.volumes[id] === 0,
    );
    const next = advanceDuck(previous, {
      speech: duckers.length > 0,
      level: s.duckingLevel,
      now: performance.now(),
    });
    this.duck = next;
    if (Math.abs(next.gain - previous.gain) > 0.001) this.applyVolumes();
    const ducking = next.gain < 0.999;
    if (ducking !== s.duckingNow) set({ duckingNow: ducking });
  }

  async resumeAudio(): Promise<void> {
    try {
      await this.room?.startAudio();
      set({ audioPlaybackBlocked: !(this.room?.canPlaybackAudio ?? true) });
    } catch {
      set({ audioPlaybackBlocked: true });
    }
  }

  async startScreenShare(opts: {
    audio: boolean;
    preset: ScreenSharePresetId;
    desktopSourceId?: string;
  }): Promise<void> {
    const room = this.room;
    if (!room || get().status !== 'connected' || get().shareStarting) return;
    set({ shareStarting: true, screenSharePreset: opts.preset });
    const preset = SCREEN_SHARE_PRESETS[opts.preset];
    try {
      if (room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare)) {
        await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      }
      const bridge = platform().desktop;
      if (bridge) {
        if (!opts.desktopSourceId) throw new Error('No source selected.');
        const armed = await bridge.capture.selectSource({
          sourceId: opts.desktopSourceId,
          audio: opts.audio,
        });
        if (!armed.ok) throw new Error(armed.error);
      }
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: opts.audio
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                restrictOwnAudio: true,
              }
            : false,
          resolution: { width: preset.width, height: preset.height, frameRate: preset.frameRate },
          contentHint: opts.preset === '1080p30' ? 'motion' : 'detail',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: opts.audio ? 'include' : 'exclude',
        },
        {
          screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate },
          degradationPreference: 'maintain-resolution',
        },
      );
      const hasAudio = !!room.localParticipant.getTrackPublication(
        lk.Track.Source.ScreenShareAudio,
      );
      set({ localShare: { hasAudio, audioRequested: opts.audio, preset: opts.preset } });
      playCue('share-start');
      if (opts.audio && !hasAudio) {
        toast('This source did not provide audio, so only video is being shared.', 'info', 8000);
      }
      this.notifyTracks();
    } catch (err) {
      await this.explainShareFailure(err);
    } finally {
      set({ shareStarting: false });
    }
  }

  private async explainShareFailure(err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'AbortError') return;
    if (name === 'NotAllowedError') {
      const bridge = platform().desktop;
      if (bridge) {
        const status = await bridge.media.getAccessStatus().catch(() => null);
        if (status?.screen === 'denied') {
          toast(
            'Screen recording is not allowed for Hostile. Enable it in System Settings → Privacy & Security → Screen Recording, then restart the app.',
            'error',
            12000,
          );
          return;
        }
      }
      toast('Screen sharing was cancelled or not permitted.', 'info');
      return;
    }
    if (name === 'NotFoundError') {
      toast('No screen or window is available to share.', 'error');
      return;
    }
    if (name === 'NotReadableError') {
      toast('The system refused to capture that source. Try another window or screen.', 'error');
      return;
    }
    toast(`Could not start screen sharing: ${errorMessage(err)}`, 'error');
  }

  private syncLocalShare(): void {
    const room = this.room;
    if (!room) return;
    const video = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare);
    const audio = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio);
    if (!video?.track) {
      if (get().localShare) {
        set({ localShare: null });
        this.cueShareStopSoon(room, room.localParticipant.identity);
      }
      return;
    }
    const current = get().localShare;
    set({
      localShare: {
        hasAudio: !!audio?.track,
        audioRequested: current?.audioRequested ?? !!audio?.track,
        preset: current?.preset ?? get().screenSharePreset,
      },
    });
  }

  async stopScreenShare(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (get().localShare) playCue('share-stop');
    set({ localShare: null });
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } finally {
      this.notifyTracks();
    }
  }

  getScreenShareTrack(userId: string): RemoteVideoTrack | LocalVideoTrack | null {
    const room = this.room;
    if (!room) return null;
    if (userId === room.localParticipant.identity) {
      return (
        (room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare)
          ?.track as LocalVideoTrack) ?? null
      );
    }
    const p = room.remoteParticipants.get(userId);
    const track = p?.getTrackPublication(lk.Track.Source.ScreenShare)?.track;
    return (track as RemoteVideoTrack | undefined) ?? null;
  }

  localIdentity(): string | null {
    return this.room?.localParticipant.identity ?? null;
  }

  watchShare(userId: string): () => void {
    this.watchCounts.set(userId, (this.watchCounts.get(userId) ?? 0) + 1);
    this.queueWatchFlush();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.watchCounts.get(userId) ?? 1) - 1;
      if (left > 0) this.watchCounts.set(userId, left);
      else this.watchCounts.delete(userId);
      this.queueWatchFlush();
    };
  }

  private queueWatchFlush() {
    if (this.watchFlushQueued) return;
    this.watchFlushQueued = true;
    queueMicrotask(() => {
      this.watchFlushQueued = false;
      const now = [...this.watchCounts.keys()].sort();
      const before = new Set(this.watched);
      if (now.length === before.size && now.every((id) => before.has(id))) return;
      this.watched = now;
      const at = performance.now();
      if (
        get().status === 'connected' &&
        now.some(
          (id) =>
            !before.has(id) &&
            at - Math.max(this.connectedAt, this.shareCuedAt.get(id) ?? 0) > AUTO_VIEW_QUIET_MS,
        )
      ) {
        playCue('viewer-join');
      }
      this.reportSelfState();
    });
  }

  onTracksChanged(listener: () => void): () => void {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  }

  private notifyTracks() {
    for (const l of this.trackListeners) l();
  }

  private baselineCues(room: Room) {
    this.cuedParticipants = new Set(room.remoteParticipants.keys());
    this.cuedSharers = new Set(
      [...room.remoteParticipants.values()]
        .filter((p) => p.getTrackPublication(lk.Track.Source.ScreenShare))
        .map((p) => p.identity),
    );
    this.audiences = null;
    this.checkAudiences();
  }

  private cueLeaveSoon(room: Room, identity: string) {
    setTimeout(() => {
      if (
        this.room === room &&
        room.state === lk.ConnectionState.Connected &&
        !room.remoteParticipants.has(identity)
      ) {
        playCue('leave');
      }
    }, LEAVE_CUE_DELAY_MS);
  }

  private cueShareStopSoon(room: Room, identity: string) {
    setTimeout(() => {
      if (this.room !== room || room.state !== lk.ConnectionState.Connected) return;
      const self = identity === room.localParticipant.identity;
      const p = self ? room.localParticipant : room.remoteParticipants.get(identity);
      if (p && !p.getTrackPublication(lk.Track.Source.ScreenShare)) playCue('share-stop');
    }, LEAVE_CUE_DELAY_MS);
  }

  private checkAudiences() {
    const s = get();
    const selfId = this.localIdentity();
    if (s.status !== 'connected' || !s.channelId || !selfId) {
      this.audiences = null;
      return;
    }
    const next = audiencesOf(useCommunity.getState().voice.rooms[s.channelId] ?? []);
    const prev = this.audiences?.channelId === s.channelId ? this.audiences.map : null;
    this.audiences = { channelId: s.channelId, map: next };
    if (!prev) return;
    const now = Date.now();
    for (const [key, at] of this.viewerLeftAt) {
      if (now - at > VIEWER_REJOIN_GRACE_MS) this.viewerLeftAt.delete(key);
    }
    for (const { sharer, viewer } of viewerPairsAdded(next, prev)) {
      this.viewerLeftAt.set(`${sharer}:${viewer}`, now);
    }
    const joined = cueViewerJoin(viewerPairsAdded(prev, next), {
      selfId,
      partOf: (sharer) =>
        sharer === selfId
          ? !!s.localShare
          : this.watchCounts.has(sharer) && !!s.remotes[sharer]?.screenShare,
      recentlyLeft: ({ sharer, viewer }) => this.viewerLeftAt.has(`${sharer}:${viewer}`),
    });
    if (joined) playCue('viewer-join');
  }

  private updateRemote(p: RemoteParticipant) {
    const mic = p.getTrackPublication(lk.Track.Source.Microphone);
    const state: RemoteState = {
      userId: p.identity,
      hasMic: !!mic,
      micMuted: mic ? mic.isMuted : true,
      screenShare: !!p.getTrackPublication(lk.Track.Source.ScreenShare),
      screenShareAudio: !!p.getTrackPublication(lk.Track.Source.ScreenShareAudio),
      quality: qualityName(p.connectionQuality),
    };
    set((s) => ({ remotes: { ...s.remotes, [p.identity]: state } }));
  }

  private removeRemote(identity: string) {
    set((s) => {
      const remotes = { ...s.remotes };
      delete remotes[identity];
      const speaking = { ...s.speaking };
      delete speaking[identity];
      return { remotes, speaking };
    });
  }

  private bindRoomEvents(room: Room) {
    const mine = () => this.room === room;

    room
      .on(lk.RoomEvent.ParticipantConnected, (p) => {
        if (!mine()) return;
        this.updateRemote(p);
        this.applyVolumes();
        if (room.state === lk.ConnectionState.Connected && !this.cuedParticipants.has(p.identity)) {
          this.cuedParticipants.add(p.identity);
          playCue('join');
        }
      })
      .on(lk.RoomEvent.ParticipantDisconnected, (p) => {
        if (!mine()) return;
        this.removeRemote(p.identity);
        this.notifyTracks();
        this.cuedSharers.delete(p.identity);
        if (this.cuedParticipants.delete(p.identity)) this.cueLeaveSoon(room, p.identity);
      })
      .on(lk.RoomEvent.TrackPublished, (pub, p) => {
        if (!mine()) return;
        this.updateRemote(p);
        if (
          pub.source === lk.Track.Source.ScreenShare &&
          room.state === lk.ConnectionState.Connected &&
          !this.cuedSharers.has(p.identity)
        ) {
          this.cuedSharers.add(p.identity);
          this.shareCuedAt.set(p.identity, performance.now());
          playCue('share-start');
        }
      })
      .on(lk.RoomEvent.TrackUnpublished, (pub, p) => {
        if (!mine()) return;
        if (pub.source === lk.Track.Source.ScreenShare && this.cuedSharers.delete(p.identity)) {
          this.cueShareStopSoon(room, p.identity);
        }
        this.updateRemote(p);
        this.notifyTracks();
      })
      .on(lk.RoomEvent.TrackMuted, (_pub, p) => {
        if (!mine()) return;
        if (p.isLocal) void this.enforceMicState();
        else this.updateRemote(p as RemoteParticipant);
      })
      .on(lk.RoomEvent.TrackUnmuted, (_pub, p) => {
        if (!mine()) return;
        if (p.isLocal) void this.enforceMicState();
        else {
          this.updateRemote(p as RemoteParticipant);
          this.applyVolumes();
        }
      })
      .on(lk.RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p) => {
        if (!mine()) return;
        if (track.kind === lk.Track.Kind.Audio) {
          for (const stale of Array.from(this.audioSink.children) as HTMLMediaElement[]) {
            if (!stale.srcObject) stale.remove();
          }
          const el = track.attach();
          el.setAttribute('data-user', p.identity);
          el.setAttribute('data-source', track.source);
          this.audioSink.appendChild(el);
          this.applyVolumes();
        }
        this.updateRemote(p);
        this.notifyTracks();
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p) => {
        for (const el of track.detach()) el.remove();
        if (!mine()) return;
        this.updateRemote(p);
        this.notifyTracks();
      })
      .on(lk.RoomEvent.LocalTrackPublished, (pub) => {
        if (!mine()) return;
        if (pub.source === lk.Track.Source.Microphone) void this.enforceMicState();
        if (
          pub.source === lk.Track.Source.ScreenShare ||
          pub.source === lk.Track.Source.ScreenShareAudio
        ) {
          this.syncLocalShare();
        }
        this.notifyTracks();
      })
      .on(lk.RoomEvent.LocalTrackUnpublished, (pub) => {
        if (!mine()) return;
        if (
          pub.source === lk.Track.Source.ScreenShare ||
          pub.source === lk.Track.Source.ScreenShareAudio
        ) {
          this.syncLocalShare();
        }
        this.notifyTracks();
      })
      .on(lk.RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!mine()) return;
        set({ speaking: Object.fromEntries(speakers.map((sp) => [sp.identity, true])) });
      })
      .on(lk.RoomEvent.ConnectionQualityChanged, (quality, p) => {
        if (!mine()) return;
        if (p.isLocal) {
          set({ connectionQuality: qualityName(quality) });
          return;
        }
        set((s) => {
          const r = s.remotes[p.identity];
          return r
            ? { remotes: { ...s.remotes, [p.identity]: { ...r, quality: qualityName(quality) } } }
            : {};
        });
      })
      .on(lk.RoomEvent.Reconnecting, () => mine() && set({ status: 'reconnecting' }))
      .on(lk.RoomEvent.SignalReconnecting, () => mine() && set({ status: 'reconnecting' }))
      .on(lk.RoomEvent.Reconnected, () => {
        if (!mine()) return;
        set({ status: 'connected' });
        this.baselineCues(room);
        for (const p of room.remoteParticipants.values()) this.updateRemote(p);
        this.applyVolumes();
        void this.enforceMicState().then(() => {
          if (!mine()) return;
          if (!get().micPublished && get().status === 'connected') void this.retryMicrophone();
          else if (get().micPublished && isMicError(get().error)) set({ error: null });
        });
        this.syncLocalShare();
        this.reportSelfState();
        this.notifyTracks();
      })
      .on(lk.RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!mine() || this.leaving) return;
        playCue('leave');
        const err = mapDisconnectReason(reason);
        const seq = ++this.joinSeq;
        void this.teardown().then(() => {
          if (seq === this.joinSeq) this.resetIdle(err);
        });
      })
      .on(lk.RoomEvent.MediaDevicesChanged, () => {
        if (mine()) void this.refreshDevices();
      })
      .on(lk.RoomEvent.MediaDevicesError, (err: Error, kind?: MediaDeviceKind) => {
        if (mine() && kind === 'audioinput') set({ error: mapMicError(err) });
      })
      .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => {
        if (mine()) set({ audioPlaybackBlocked: !room.canPlaybackAudio });
      });
  }

  async diagnostics(): Promise<VoiceDiagnostics | null> {
    const room = this.room;
    if (!room) return null;
    let candidateType: string | null = null;
    let protocol: string | null = null;
    let localAudio: VoiceDiagnostics['localAudio'] = null;
    const report = await this.micTrack?.getRTCStatsReport().catch(() => undefined);
    if (report) {
      const byId = new Map<string, Record<string, unknown>>();
      report.forEach((v) => byId.set((v as { id: string }).id, v as Record<string, unknown>));
      report.forEach((v) => {
        const stat = v as Record<string, unknown>;
        if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
          localAudio = {
            bytesSent: Number(stat.bytesSent ?? 0),
            packetsSent: Number(stat.packetsSent ?? 0),
          };
        }
        if (stat.type === 'candidate-pair' && (stat.nominated || stat.state === 'succeeded')) {
          const local = byId.get(String(stat.localCandidateId));
          if (local) {
            candidateType = String(local.candidateType ?? '');
            protocol = String(local.relayProtocol ?? local.protocol ?? '');
          }
        }
      });
    }
    const remotes: VoiceDiagnostics['remotes'] = [];
    for (const p of room.remoteParticipants.values()) {
      const audio = p.getTrackPublication(lk.Track.Source.Microphone)?.track;
      const screen = p.getTrackPublication(lk.Track.Source.ScreenShare)?.track;
      const screenAudio = p.getTrackPublication(lk.Track.Source.ScreenShareAudio)?.track;
      const [a, v, sa] = await Promise.all([
        inboundStats(audio),
        inboundStats(screen),
        inboundStats(screenAudio),
      ]);
      remotes.push({
        userId: p.identity,
        audioBytesReceived: a ? Number(a.bytesReceived ?? 0) : null,
        audioSamplesReceived: a ? Number(a.totalSamplesReceived ?? 0) : null,
        audioEnergy: a ? Number(a.totalAudioEnergy ?? 0) : null,
        audioLevel: p.audioLevel,
        screenFramesDecoded: v ? Number(v.framesDecoded ?? 0) : null,
        screenSize: v?.frameWidth ? `${String(v.frameWidth)}×${String(v.frameHeight)}` : null,
        screenAudioBytesReceived: sa ? Number(sa.bytesReceived ?? 0) : null,
        screenAudioVolume: screenAudio
          ? (p.getVolume(lk.Track.Source.ScreenShareAudio) ?? null)
          : null,
      });
    }
    return {
      connectionState: room.state,
      serverUrl: this.serverUrl,
      candidateType,
      protocol,
      localAudio,
      noiseSuppression: {
        mode: effectiveNoiseMode(get().processing.noiseMode, get().suppressorFailures),
        processor: this.micTrack?.getProcessor()?.name ?? null,
        failures: Object.entries(get().suppressorFailures).map(
          ([engine, reason]) =>
            `${SUPPRESSOR_MODE_NAMES[engine as InAppSuppressor].toLowerCase()}: ${reason}`,
        ),
      },
      remotes,
    };
  }
}

async function inboundStats(track: unknown): Promise<Record<string, unknown> | null> {
  if (!track || typeof (track as { getRTCStatsReport?: unknown }).getRTCStatsReport !== 'function')
    return null;
  const report = await (track as { getRTCStatsReport(): Promise<RTCStatsReport | undefined> })
    .getRTCStatsReport()
    .catch(() => undefined);
  if (!report) return null;
  let found: Record<string, unknown> | null = null;
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (stat.type === 'inbound-rtp') found = stat;
  });
  return found;
}

let controller: VoiceController | null = null;

export function voice(): VoiceController {
  controller ??= new VoiceController();
  return controller;
}
