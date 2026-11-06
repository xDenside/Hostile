import type { RemoteState, VoiceStatus } from './store';

export interface ConnectionSignal {
  bars: 0 | 1 | 2 | 3;
  seeking: boolean;
  lost: boolean;
  label: string;
}

const RATED: Record<RemoteState['quality'], Pick<ConnectionSignal, 'bars' | 'label'>> = {
  excellent: { bars: 3, label: 'Connection: excellent' },
  good: { bars: 2, label: 'Connection: good' },
  poor: { bars: 1, label: 'Connection: poor' },
  lost: { bars: 0, label: 'Connection lost' },
  unknown: { bars: 0, label: 'Checking the connection' },
};

export function connectionSignal(
  status: VoiceStatus,
  quality: RemoteState['quality'],
): ConnectionSignal {
  if (status !== 'connected') {
    return { bars: 0, seeking: true, lost: false, label: 'Connecting' };
  }
  return { ...RATED[quality], seeking: false, lost: quality === 'lost' };
}
