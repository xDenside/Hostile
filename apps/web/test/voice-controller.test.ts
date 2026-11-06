import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { voice } from '../src/features/voice/controller';
import { useVoice } from '../src/features/voice/store';
import { defaultAudioProcessing } from '../src/features/voice/audio-processing';
import { useUi } from '../src/stores/ui';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTrack {
  mediaStreamTrack: { readyState: string; enabled: boolean };
  stop: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const makeTrack = (): FakeTrack => ({
  mediaStreamTrack: { readyState: 'live', enabled: true },
  stop: vi.fn(),
  mute: vi.fn(async () => undefined),
  on: vi.fn(),
});

const hoisted = vi.hoisted(() => {
  const state = {
    rooms: [] as InstanceType<typeof FakeRoom>[],
    captures: [] as Promise<unknown>[],
    publishes: new Map<number, Promise<void>>(),
    deviceListeners: [] as unknown[],
    attach: vi.fn(),
    made: [] as unknown[],
  };
  class FakeRoom {
    index = state.rooms.length;
    events = new Map<string, ((...args: unknown[]) => void)[]>();
    remoteParticipants = new Map();
    state = 'connected';
    canPlaybackAudio = true;
    onDisconnect: (() => void) | null = null;
    publications = new Map<string, unknown>();
    localParticipant = {
      identity: 'me',
      trackPublications: this.publications,
      getTrackPublication: () => undefined,
      unpublishTrack: vi.fn(async () => undefined),
      publishTrack: vi.fn(async (track: unknown) => {
        await state.publishes.get(this.index);
        this.publications.set('mic', {
          source: 'microphone',
          track,
          isMuted: false,
          mute: async () => undefined,
          unmute: async () => undefined,
        });
      }),
    };
    static cleanupRegistry: unknown = {};
    deviceListener = () => undefined;
    constructor() {
      state.rooms.push(this);
      navigator.mediaDevices.addEventListener(
        'devicechange',
        FakeRoom.cleanupRegistry ? () => undefined : this.deviceListener,
      );
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.events.set(event, [...(this.events.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.events.get(event) ?? []) handler(...args);
    }
    connect = async () => undefined;
    disconnect = async () => {
      this.onDisconnect?.();
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceListener);
    };
  }
  return { state, FakeRoom };
});

vi.mock('livekit-client', () => {
  const names = () => new Proxy({}, { get: (_t, key) => String(key) });
  return {
    Room: hoisted.FakeRoom,
    RoomEvent: names(),
    TrackEvent: names(),
    ConnectionState: names(),
    ConnectionQuality: names(),
    ConnectionErrorReason: names(),
    DisconnectReason: names(),
    ConnectionError: class extends Error {},
    MediaDeviceFailure: { getFailure: () => undefined },
    Track: {
      Source: {
        Microphone: 'microphone',
        ScreenShare: 'screen_share',
        ScreenShareAudio: 'screen_share_audio',
      },
      Kind: { Audio: 'audio' },
    },
    createLocalAudioTrack: async () => (await hoisted.state.captures.shift()) ?? makeTrack(),
    supportsAudioOutputSelection: () => true,
  };
});

vi.mock('../src/api/client', () => ({
  ApiError: class extends Error {},
  errorMessage: (err: Error) => err.message,
  mediaUrl: (path: string) => path,
  endpoints: { voiceToken: async () => ({ url: 'ws://voice.test', token: 'token' }) },
}));
vi.mock('../src/platform', () => ({ platform: () => ({ kind: 'web' }) }));
vi.mock('../src/realtime/socket', () => ({
  emitVoiceSelfState: vi.fn(),
  onRealtimeConnect: () => () => undefined,
}));
vi.mock('../src/features/voice/sounds', () => ({ playCue: vi.fn(), preloadCues: vi.fn() }));
vi.mock('../src/features/voice/suppressor', () => ({
  attachNoiseSuppressor: hoisted.state.attach,
}));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const { rooms } = hoisted.state;

function fakeElement() {
  const children: unknown[] = [];
  return {
    children,
    id: '',
    hidden: false,
    srcObject: {} as unknown,
    setAttribute: vi.fn(),
    appendChild(child: { parent: unknown[] }) {
      children.push(child);
      child.parent = children;
    },
    parent: null as unknown[] | null,
    remove() {
      this.parent?.splice(this.parent.indexOf(this), 1);
    },
  };
}

const mediaDevices = {
  addEventListener(type: string, listener: unknown) {
    if (type === 'devicechange') hoisted.state.deviceListeners.push(listener);
  },
  removeEventListener(type: string, listener: unknown) {
    if (type !== 'devicechange') return;
    const at = hoisted.state.deviceListeners.indexOf(listener);
    if (at !== -1) hoisted.state.deviceListeners.splice(at, 1);
  },
  enumerateDevices: async () => [],
};

vi.stubGlobal('document', { createElement: fakeElement, body: { appendChild: () => undefined } });
vi.stubGlobal('navigator', { mediaDevices, userAgent: 'test' });

beforeEach(async () => {
  await voice().leave();
  rooms.length = 0;
  hoisted.state.captures.length = 0;
  hoisted.state.publishes.clear();
  hoisted.state.attach.mockReset();
  useVoice.setState({
    processing: defaultAudioProcessing,
    suppressorFailures: {},
    micPublished: false,
    error: null,
  });
});

afterEach(() => voice().leave());

describe('switching voice channels while the microphone is still starting', () => {
  it('publishes in the new call even though the old call is still opening its capture', async () => {
    const first = deferred<FakeTrack>();
    const firstTrack = makeTrack();
    hoisted.state.captures.push(first.promise);

    void voice().join('channel-a');
    await settle();
    const joined = voice().join('channel-b');
    await settle();
    first.resolve(firstTrack);
    await joined;
    await settle();

    expect(rooms).toHaveLength(2);
    expect(rooms[1]!.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().micPublished).toBe(true);
    expect(useVoice.getState().channelId).toBe('channel-b');
    expect(firstTrack.stop).toHaveBeenCalled();
    expect(rooms[0]!.localParticipant.publishTrack).not.toHaveBeenCalled();
  });

  it('does not make the new call wait for an old publish that is stuck', async () => {
    hoisted.state.publishes.set(0, new Promise(() => undefined));

    void voice().join('channel-a');
    await settle();
    expect(rooms[0]!.localParticipant.publishTrack).toHaveBeenCalledTimes(1);

    await voice().join('channel-b');

    expect(rooms[1]!.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().micPublished).toBe(true);
  });

  it('lets a late failure of the old publish leave the new call alone', async () => {
    useVoice.setState({ processing: { ...defaultAudioProcessing, noiseMode: 'enhanced' } });
    const oldProcessor = { engine: 'rnnoise', destroy: vi.fn(async () => undefined) };
    const newProcessor = { engine: 'rnnoise', destroy: vi.fn(async () => undefined) };
    hoisted.state.attach.mockResolvedValueOnce(oldProcessor).mockResolvedValueOnce(newProcessor);
    const oldPublish = deferred();
    hoisted.state.publishes.set(0, oldPublish.promise);

    void voice().join('channel-a');
    await settle();
    await voice().join('channel-b');
    expect(newProcessor.destroy).not.toHaveBeenCalled();

    oldPublish.reject(new Error('the room it was for has gone'));
    await settle();

    expect(oldProcessor.destroy).toHaveBeenCalled();
    expect(newProcessor.destroy).not.toHaveBeenCalled();
    expect(useVoice.getState().micPublished).toBe(true);
    expect(useVoice.getState().error).toBeNull();
  });

  it('still publishes only once when a retry arrives during the first publish', async () => {
    const capture = deferred<FakeTrack>();
    hoisted.state.captures.push(capture.promise);
    const joined = voice().join('channel-a');
    await settle();

    void voice().retryMicrophone();
    await settle();
    capture.resolve(makeTrack());
    await joined;
    await settle();

    expect(rooms[0]!.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  });
});

describe('how steady the connection is', () => {
  it("follows LiveKit's rating of this machine, and not of anyone else", async () => {
    await voice().join('channel-a');
    await settle();
    expect(useVoice.getState().connectionQuality).toBe('unknown');

    const room = rooms[0]!;
    room.emit('ConnectionQualityChanged', 'Excellent', { isLocal: true, identity: 'me' });
    expect(useVoice.getState().connectionQuality).toBe('excellent');
    room.emit('ConnectionQualityChanged', 'Lost', { isLocal: false, identity: 'them' });
    expect(useVoice.getState().connectionQuality).toBe('excellent');
    room.emit('ConnectionQualityChanged', 'Poor', { isLocal: true, identity: 'me' });
    expect(useVoice.getState().connectionQuality).toBe('poor');
  });

  it('starts again for the next call, and is not told by the last one', async () => {
    await voice().join('channel-a');
    await settle();
    rooms[0]!.emit('ConnectionQualityChanged', 'Poor', { isLocal: true, identity: 'me' });

    await voice().join('channel-b');
    await settle();
    expect(useVoice.getState().connectionQuality).toBe('unknown');
    rooms[0]!.emit('ConnectionQualityChanged', 'Poor', { isLocal: true, identity: 'me' });
    expect(useVoice.getState().connectionQuality).toBe('unknown');

    await voice().leave();
    expect(useVoice.getState().connectionQuality).toBe('unknown');
  });
});

describe('leaving a call', () => {
  it('detaches remote tracks while the room unwinds, and empties every audio element', async () => {
    await voice().join('channel-a');
    const room = rooms[0]!;
    const detached = fakeElement();
    const remote = {
      kind: 'audio',
      source: 'microphone',
      attach: () => detached,
      detach: vi.fn(() => [detached]),
    };
    const participant = { identity: 'them', getTrackPublication: () => undefined };
    room.emit('TrackSubscribed', remote, {}, participant);
    const stray = fakeElement();
    const orphan = { kind: 'audio', source: 'microphone', attach: () => stray, detach: vi.fn() };
    room.emit('TrackSubscribed', orphan, {}, participant);
    room.onDisconnect = () => room.emit('TrackUnsubscribed', remote, {}, participant);

    await voice().leave();

    expect(remote.detach).toHaveBeenCalled();
    expect(detached.parent).toEqual([]);
    expect(stray.srcObject).toBeNull();
    expect(stray.parent).toEqual([]);
  });

  it('does not touch audio the next call has already started playing', async () => {
    await voice().join('channel-a');
    const first = rooms[0]!;
    const participant = { identity: 'them', getTrackPublication: () => undefined };
    const gate = deferred();
    first.disconnect = () => gate.promise;

    const switching = voice().leave();
    await settle();
    const next = voice().join('channel-b');
    await next;
    const playing = fakeElement();
    rooms[1]!.emit(
      'TrackSubscribed',
      { kind: 'audio', source: 'microphone', attach: () => playing, detach: () => [playing] },
      {},
      participant,
    );
    gate.resolve();
    await switching;

    expect(playing.srcObject).not.toBeNull();
    expect(playing.parent).toHaveLength(1);
    expect(useVoice.getState().status).toBe('connected');
    expect(useVoice.getState().channelId).toBe('channel-b');
  });

  it('removes the device listener each Room adds, so that the Room can be collected', async () => {
    const before = hoisted.state.deviceListeners.length;
    await voice().join('channel-a');
    await voice().join('channel-b');
    expect(hoisted.state.deviceListeners).toHaveLength(before + 1);
    await voice().leave();
    expect(hoisted.state.deviceListeners).toHaveLength(before);
  });
});

describe('a noise suppressor that cannot run', () => {
  const reason = 'this computer could not keep up with it';

  it('changes to standard without a word when strong was only the default, and keeps the reason', () => {
    useUi.setState({ toasts: [] });
    useVoice.setState({ processing: { ...defaultAudioProcessing, noiseModeChosen: false } });
    voice().noteSuppressorFailed('fastenhancer', reason);
    expect(useVoice.getState().suppressorFailures).toEqual({ fastenhancer: reason });
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('still says so when the person chose it', () => {
    useUi.setState({ toasts: [] });
    useVoice.setState({ processing: { ...defaultAudioProcessing, noiseModeChosen: true } });
    voice().noteSuppressorFailed('fastenhancer', reason);
    expect(useUi.getState().toasts).toHaveLength(1);
    expect(useUi.getState().toasts[0]).toMatchObject({ kind: 'error' });
    expect(useUi.getState().toasts[0]!.text).toMatch(/^Strong noise suppression could not start/);
  });
});
