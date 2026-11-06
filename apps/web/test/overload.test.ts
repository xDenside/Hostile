import { describe, expect, it } from 'vitest';
import {
  OVERLOAD_GIVE_UP_AFTER_MS,
  OVERLOAD_REPEAT_LIMIT,
  OVERLOAD_REPEAT_WINDOW_MS,
  OverloadWatch,
} from '../src/features/voice/overload';

describe('OverloadWatch', () => {
  it('rides out a single stall that recovers', () => {
    const watch = new OverloadWatch();
    expect(watch.change(true, 0)).toBe(false);
    expect(watch.stuck(1000)).toBe(false);
    expect(watch.change(false, 1500)).toBe(false);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS * 10)).toBe(false);
  });

  it('gives up on a stall that never recovers', () => {
    const watch = new OverloadWatch();
    watch.change(true, 0);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS - 1)).toBe(false);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS)).toBe(true);
  });

  it('gives up on a computer that keeps falling behind, however short each stall', () => {
    const watch = new OverloadWatch();
    const verdicts: boolean[] = [];
    for (let i = 0; i < OVERLOAD_REPEAT_LIMIT; i++) {
      verdicts.push(watch.change(true, i * 10_000));
      watch.change(false, i * 10_000 + 200);
    }
    expect(verdicts.slice(0, -1).every((v) => !v)).toBe(true);
    expect(verdicts.at(-1)).toBe(true);
  });

  it('forgets stalls older than the window', () => {
    const watch = new OverloadWatch();
    const spacing = OVERLOAD_REPEAT_WINDOW_MS;
    for (let i = 0; i < OVERLOAD_REPEAT_LIMIT + 2; i++) {
      expect(watch.change(true, i * spacing)).toBe(false);
      watch.change(false, i * spacing + 200);
    }
  });

  it('starts both clocks again from a forgiven moment, as when a phone comes back to the front', () => {
    const watch = new OverloadWatch();
    watch.change(true, 0);
    watch.change(false, 100);
    watch.change(true, 200);
    watch.forgive(OVERLOAD_GIVE_UP_AFTER_MS * 3);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS * 3 + 1)).toBe(false);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS * 4)).toBe(true);
    watch.change(false, OVERLOAD_GIVE_UP_AFTER_MS * 4);
    expect(watch.change(true, OVERLOAD_GIVE_UP_AFTER_MS * 4 + 100)).toBe(false);
  });

  it('leaves a watch that was not engaged unengaged when it forgives', () => {
    const watch = new OverloadWatch();
    watch.forgive(1000);
    expect(watch.stuck(OVERLOAD_GIVE_UP_AFTER_MS * 10)).toBe(false);
  });
});
