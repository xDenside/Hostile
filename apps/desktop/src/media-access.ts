import { shell, systemPreferences } from 'electron';
import type { MediaAccessStatus, MediaPermissionState } from '@hostile/shared';
import { log, messageOf } from './log.js';
import { isProofBuild } from './proof.js';

const MAC_SETTINGS_URL = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
} as const;

const WINDOWS_SETTINGS_URL: Partial<Record<'microphone' | 'screen', string>> = {
  microphone: 'ms-settings:privacy-microphone',
};

function normalize(status: string): MediaPermissionState {
  switch (status) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return status;
    default:
      return 'unknown';
  }
}

export function mediaAccessStatus(): MediaAccessStatus {
  if (isProofBuild()) return { microphone: 'granted', screen: 'granted' };
  if (process.platform === 'darwin') {
    return {
      microphone: normalize(systemPreferences.getMediaAccessStatus('microphone')),
      screen: normalize(systemPreferences.getMediaAccessStatus('screen')),
    };
  }
  if (process.platform === 'win32') {
    return {
      microphone: normalize(systemPreferences.getMediaAccessStatus('microphone')),
      screen: 'granted',
    };
  }
  return { microphone: 'unknown', screen: 'granted' };
}

export async function requestMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin' || isProofBuild()) return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (err) {
    log.warn(`asking macOS for microphone access failed: ${messageOf(err)}`);
    return false;
  }
}

export async function openPrivacySettings(kind: 'microphone' | 'screen'): Promise<void> {
  const url: string | undefined =
    process.platform === 'darwin'
      ? MAC_SETTINGS_URL[kind]
      : process.platform === 'win32'
        ? WINDOWS_SETTINGS_URL[kind]
        : undefined;
  if (!url) {
    log.info(`no privacy settings page to open for "${kind}" on this platform`);
    return;
  }
  try {
    await shell.openExternal(url);
  } catch (err) {
    log.warn(`could not open the ${kind} privacy settings: ${messageOf(err)}`);
  }
}
