import { create } from 'zustand';
import { DEFAULT_SCREEN_SHARE_PRESET, type ScreenSharePresetId } from '@hostile/shared';
import { loadJson, saveJson } from '../../lib/storage';
import { useSession } from '../../stores/session';
import {
  defaultAudioProcessing,
  inAppSuppressionSupported,
  migrateAudioProcessing,
  type AudioProcessing,
  type SuppressorFailures,
} from './audio-processing';
import {
  defaultBindings,
  isMacLike,
  sanitizeBindings,
  type ShortcutBindings,
} from '../shortcuts/bindings';
import { DUCKING_LEVEL_DEFAULT } from './ducking';

export type { AudioProcessing } from './audio-processing';

export type VoiceStatus = 'idle' | 'requesting-token' | 'connecting' | 'connected' | 'reconnecting';

export type VoiceErrorKind =
  | 'auth'
  | 'forbidden'
  | 'unavailable'
  | 'signal'
  | 'media'
  | 'mic-denied'
  | 'mic-missing'
  | 'mic-busy'
  | 'duplicate'
  | 'removed'
  | 'room-closed'
  | 'disconnected'
  | 'unknown';

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
}

export interface RemoteState {
  userId: string;
  hasMic: boolean;
  micMuted: boolean;
  screenShare: boolean;
  screenShareAudio: boolean;
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
}

export interface LocalShare {
  hasAudio: boolean;
  audioRequested: boolean;
  preset: ScreenSharePresetId;
}

interface DevicePrefs {
  inputDeviceId: string;
  outputDeviceId: string;
  processing: AudioProcessing;
  screenSharePreset: ScreenSharePresetId;
}

interface PersonalPrefs {
  volumes: Record<string, number>;
  streamVolumes: Record<string, number>;
  localMutes: Record<string, boolean>;
  streamDucking: boolean;
  duckingLevel: number;
  micMuted: boolean;
  callSounds: boolean;
  shortcuts: ShortcutBindings;
}

export interface VoiceState extends DevicePrefs, PersonalPrefs {
  status: VoiceStatus;
  channelId: string | null;
  error: VoiceError | null;
  micPublished: boolean;
  deafened: boolean;
  speaking: Record<string, boolean>;
  remotes: Record<string, RemoteState>;
  connectionQuality: RemoteState['quality'];
  localShare: LocalShare | null;
  shareStarting: boolean;
  duckingNow: boolean;
  audioPlaybackBlocked: boolean;
  devices: { input: MediaDeviceInfo[]; output: MediaDeviceInfo[] };
  outputSelectionSupported: boolean;
  suppressorFailures: SuppressorFailures;
  processingBusy: boolean;
}

const DEVICE_PREFS_KEY = 'voice-prefs';

const defaultDevicePrefs: DevicePrefs = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  processing: defaultAudioProcessing,
  screenSharePreset: DEFAULT_SCREEN_SHARE_PRESET,
};

const emptyPersonalPrefs = (): PersonalPrefs => ({
  volumes: {},
  streamVolumes: {},
  localMutes: {},
  streamDucking: false,
  duckingLevel: DUCKING_LEVEL_DEFAULT,
  micMuted: false,
  callSounds: true,
  shortcuts: defaultBindings(isMacLike()),
});

const storedDevice = loadJson<Partial<DevicePrefs>>(DEVICE_PREFS_KEY, {});

let personalKey: string | null = null;

function personalPrefsFor(userId: string | null): PersonalPrefs {
  personalKey = userId ? `voice-prefs:${userId}` : null;
  const stored = personalKey ? loadJson<Partial<PersonalPrefs>>(personalKey, {}) : {};
  return {
    ...emptyPersonalPrefs(),
    ...stored,
    shortcuts: sanitizeBindings(stored.shortcuts, isMacLike()),
  };
}

export const useVoice = create<VoiceState>(() => ({
  ...defaultDevicePrefs,
  ...storedDevice,
  processing: migrateAudioProcessing(storedDevice.processing, inAppSuppressionSupported()),
  ...personalPrefsFor(useSession.getState().user?.id ?? null),
  status: 'idle',
  channelId: null,
  error: null,
  micPublished: false,
  deafened: false,
  speaking: {},
  remotes: {},
  connectionQuality: 'unknown',
  localShare: null,
  shareStarting: false,
  duckingNow: false,
  audioPlaybackBlocked: false,
  devices: { input: [], output: [] },
  outputSelectionSupported: false,
  suppressorFailures: {},
  processingBusy: false,
}));

useSession.subscribe((s, prev) => {
  const userId = s.user?.id ?? null;
  if (userId === (prev.user?.id ?? null)) return;
  useVoice.setState({ ...personalPrefsFor(userId), suppressorFailures: {} });
});

useVoice.subscribe((s, prev) => {
  if (
    s.inputDeviceId !== prev.inputDeviceId ||
    s.outputDeviceId !== prev.outputDeviceId ||
    s.processing !== prev.processing ||
    s.screenSharePreset !== prev.screenSharePreset
  ) {
    const prefs: DevicePrefs = {
      inputDeviceId: s.inputDeviceId,
      outputDeviceId: s.outputDeviceId,
      processing: s.processing,
      screenSharePreset: s.screenSharePreset,
    };
    saveJson(DEVICE_PREFS_KEY, prefs);
  }
  if (
    personalKey &&
    (s.volumes !== prev.volumes ||
      s.streamVolumes !== prev.streamVolumes ||
      s.localMutes !== prev.localMutes ||
      s.streamDucking !== prev.streamDucking ||
      s.duckingLevel !== prev.duckingLevel ||
      s.micMuted !== prev.micMuted ||
      s.callSounds !== prev.callSounds ||
      s.shortcuts !== prev.shortcuts)
  ) {
    const prefs: PersonalPrefs = {
      volumes: s.volumes,
      streamVolumes: s.streamVolumes,
      localMutes: s.localMutes,
      streamDucking: s.streamDucking,
      duckingLevel: s.duckingLevel,
      micMuted: s.micMuted,
      callSounds: s.callSounds,
      shortcuts: s.shortcuts,
    };
    saveJson(personalKey, prefs);
  }
});

export function isInCall(s: VoiceState): boolean {
  return s.status !== 'idle';
}

export function isMicError(error: VoiceError | null): boolean {
  return (
    error?.kind === 'mic-denied' || error?.kind === 'mic-missing' || error?.kind === 'mic-busy'
  );
}
