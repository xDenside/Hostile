import { desktopCapturer, systemPreferences, type Streams } from 'electron';
import type { CaptureCapabilities, CaptureSource, MediaPermissionState } from '@hostile/shared';
import { log, messageOf } from './log.js';
import { atLeastMacOS } from './platform.js';

const SELECTION_TTL_MS = 15_000;

const THUMBNAIL_SIZE = { width: 320, height: 200 };

interface ArmedSelection {
  sourceId: string;
  audio: boolean;
  expiresAt: number;
}

export interface CaptureService {
  listSources(): Promise<CaptureSource[]>;
  selectSource(request: {
    sourceId: string;
    audio: boolean;
  }): { ok: true } | { ok: false; error: string };
  capabilities(): CaptureCapabilities;
  takeArmedSource(audioRequested: boolean): Promise<Streams | null>;
  forget(): void;
}

export function createCaptureService(): CaptureService {
  let offered = new Set<string>();
  let armed: ArmedSelection | null = null;

  async function getSources(thumbnails: boolean): Promise<Electron.DesktopCapturerSource[]> {
    try {
      return await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: thumbnails ? THUMBNAIL_SIZE : { width: 0, height: 0 },
        fetchWindowIcons: thumbnails,
      });
    } catch (err) {
      const detail = messageOf(err);
      if (
        process.platform === 'darwin' &&
        systemPreferences.getMediaAccessStatus('screen') !== 'granted'
      ) {
        throw new Error(
          'macOS is not allowing Hostile to record the screen. Allow it in System Settings → Privacy & ' +
            'Security → Screen Recording, then restart the app.',
          { cause: err },
        );
      }
      throw new Error(`Could not list screens and windows: ${detail}`, { cause: err });
    }
  }

  return {
    async listSources() {
      const sources = await getSources(true);
      offered = new Set(sources.map((source) => source.id));
      return sources.map<CaptureSource>((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        appIconDataUrl:
          source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
      }));
    },

    selectSource({ sourceId, audio }) {
      if (!offered.has(sourceId)) {
        return {
          ok: false,
          error: 'That screen or window is no longer available. Open the picker again.',
        };
      }
      armed = { sourceId, audio, expiresAt: Date.now() + SELECTION_TTL_MS };
      return { ok: true };
    },

    capabilities() {
      return { ...systemAudioSupport(), screenPermission: screenPermission() };
    },

    async takeArmedSource(audioRequested) {
      const selection = armed;
      armed = null;
      if (!selection) {
        log.warn('cancelled a screen capture request that no picker had armed');
        return null;
      }
      if (Date.now() > selection.expiresAt) {
        log.warn('cancelled a screen capture request whose source selection had expired');
        return null;
      }
      if (!offered.has(selection.sourceId)) return null;

      const sources = await getSources(false);
      const source = sources.find((candidate) => candidate.id === selection.sourceId);
      if (!source) {
        log.warn(`the selected source ${selection.sourceId} disappeared before capture started`);
        return null;
      }

      const wantsAudio = selection.audio && audioRequested;
      const loopback = wantsAudio && systemAudioSupport().systemAudio === 'supported';
      return {
        video: { id: source.id, name: source.name },
        ...(loopback ? { audio: 'loopback' as const } : {}),
      };
    },

    forget() {
      armed = null;
      offered = new Set();
    },
  };
}

function systemAudioSupport(): Pick<CaptureCapabilities, 'systemAudio' | 'systemAudioNote'> {
  if (process.platform === 'win32') {
    return {
      systemAudio: 'supported',
      systemAudioNote:
        'Shares everything this computer plays. On Windows 11 the app leaves its own audio out, so the ' +
        'others are not echoed back to them.',
    };
  }
  if (process.platform === 'darwin') {
    if (atLeastMacOS(14, 2)) {
      return {
        systemAudio: 'supported',
        systemAudioNote:
          'Shares the audio of what you are sharing. macOS leaves Hostile’s own audio out, so the ' +
          'others are not echoed back to them.',
      };
    }
    return {
      systemAudio: 'unsupported',
      systemAudioNote: 'Sharing computer audio needs macOS 14.2 or newer.',
    };
  }
  return {
    systemAudio: 'unsupported',
    systemAudioNote: 'Sharing computer audio is not available on Linux.',
  };
}

function screenPermission(): MediaPermissionState {
  if (process.platform !== 'darwin') {
    return 'granted';
  }
  const status = systemPreferences.getMediaAccessStatus('screen');
  return status === 'granted' ||
    status === 'denied' ||
    status === 'restricted' ||
    status === 'not-determined'
    ? status
    : 'unknown';
}
