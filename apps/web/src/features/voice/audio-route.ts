export type AudioDevice = 'computer' | 'iphone' | 'ipad';

const PHONE_SCREEN_MAX = 600;

export function audioDeviceFor(
  userAgent: string,
  maxTouchPoints: number,
  screenShortSide: number,
): AudioDevice {
  if (/iPhone|iPod/.test(userAgent)) return 'iphone';
  if (userAgent.includes('iPad')) return 'ipad';
  if (userAgent.includes('Macintosh') && maxTouchPoints > 1) {
    return screenShortSide < PHONE_SCREEN_MAX ? 'iphone' : 'ipad';
  }
  return 'computer';
}

export function audioDevice(): AudioDevice {
  const shortSide =
    typeof screen === 'undefined' ? Infinity : Math.min(screen.width, screen.height);
  return audioDeviceFor(navigator.userAgent, navigator.maxTouchPoints, shortSide);
}

export function onIOS(device: AudioDevice = audioDevice()): boolean {
  return device !== 'computer';
}

export function maxVolume(device: AudioDevice = audioDevice()): number {
  if (device === 'computer') return 2;
  return device === 'ipad' ? 1 : 0;
}

export function effectiveVolume(saved: number, device: AudioDevice = audioDevice()): number {
  const max = maxVolume(device);
  return max === 0 ? 1 : Math.min(saved, max);
}

export function mutedForMe(
  localMuted: boolean,
  savedVolume: number | undefined,
  device: AudioDevice = audioDevice(),
): boolean {
  return localMuted || (maxVolume(device) === 0 && savedVolume === 0);
}
