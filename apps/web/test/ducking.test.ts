import { describe, expect, it } from 'vitest';
import {
  advanceDuck,
  initialDuckState,
  rms,
  speakersThatDuck,
  type DuckState,
} from '../src/features/voice/ducking';

const LEVEL = 0.25;

function run(start: DuckState, speech: boolean, from: number, ms: number, step = 40): DuckState {
  let state = start;
  for (let t = from + step; t <= from + ms; t += step) {
    state = advanceDuck(state, { speech, level: LEVEL, now: t });
  }
  return state;
}

describe('stream ducking', () => {
  it('leaves the stream alone during silence', () => {
    expect(run(initialDuckState(0), false, 0, 2000).gain).toBe(1);
  });

  it('ignores a sound too short to be speech, such as a key click', () => {
    const state = run(initialDuckState(0), true, 0, 40);
    expect(run(state, false, 40, 1000).gain).toBe(1);
  });

  it('reaches the ducked level quickly once speech is confirmed', () => {
    const state = run(initialDuckState(0), true, 0, 320);
    expect(state.gain).toBe(LEVEL);
  });

  it('holds between words instead of pumping', () => {
    const talking = run(initialDuckState(0), true, 0, 400);
    const pause = run(talking, false, 400, 300);
    expect(pause.gain).toBe(LEVEL);
  });

  it('comes back gradually after speech stops', () => {
    const talking = run(initialDuckState(0), true, 0, 400);
    const justAfterHold = run(talking, false, 400, 600);
    expect(justAfterHold.gain).toBeGreaterThan(LEVEL);
    expect(justAfterHold.gain).toBeLessThan(1);
    expect(run(justAfterHold, false, 1000, 1500).gain).toBe(1);
  });

  it('never overshoots, however late a tick arrives', () => {
    const late = advanceDuck(initialDuckState(0), { speech: false, level: LEVEL, now: 60_000 });
    expect(late.gain).toBe(1);
    const talking = run(initialDuckState(0), true, 0, 400);
    const much = advanceDuck(talking, { speech: true, level: LEVEL, now: 60_000 });
    expect(much.gain).toBe(LEVEL);
  });
});

describe('who can duck a stream', () => {
  it('never counts this member, so your own voice does not lower what you hear', () => {
    expect(speakersThatDuck(['me'], 'me', () => false)).toEqual([]);
    expect(speakersThatDuck(['me', 'bob'], 'me', () => false)).toEqual(['bob']);
  });

  it('skips someone silenced here, who cannot be heard anyway', () => {
    expect(speakersThatDuck(['bob'], 'me', (id) => id === 'bob')).toEqual([]);
  });
});

describe('rms', () => {
  it('measures a frame', () => {
    expect(rms(new Float32Array([]))).toBe(0);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});
