import { describe, expect, it } from 'vitest';
import { connectionSignal } from '../src/features/voice/connection-signal';

describe('the bars beside a call', () => {
  it('light up with how LiveKit rates the connection', () => {
    expect(connectionSignal('connected', 'excellent')).toMatchObject({ bars: 3, lost: false });
    expect(connectionSignal('connected', 'good')).toMatchObject({ bars: 2, lost: false });
    expect(connectionSignal('connected', 'poor')).toMatchObject({ bars: 1, lost: false });
  });

  it('say a lost connection in the one colour kept for trouble', () => {
    expect(connectionSignal('connected', 'lost')).toMatchObject({
      bars: 0,
      lost: true,
      label: 'Connection lost',
    });
  });

  it('claim nothing before there is a rating', () => {
    expect(connectionSignal('connected', 'unknown')).toEqual({
      bars: 0,
      seeking: false,
      lost: false,
      label: 'Checking the connection',
    });
  });

  it('look for the connection while there is none, whatever the last rating was', () => {
    for (const status of ['requesting-token', 'connecting', 'reconnecting'] as const) {
      expect(connectionSignal(status, 'excellent')).toEqual({
        bars: 0,
        seeking: true,
        lost: false,
        label: 'Connecting',
      });
    }
  });
});
