import { describe, expect, it } from 'vitest';
import {
  beginSwipe,
  cancelSwipe,
  endSwipe,
  LONG_PRESS_SLOP_PX,
  moveSwipe,
  pressHeld,
  SWIPE_ARM_PX,
  SWIPE_DECIDE_PX,
  SWIPE_MAX_PX,
  swipeOffset,
  type Swipe,
} from '../src/features/chat/swipe';

const X = 300;
const Y = 400;

function through(...moves: [dx: number, dy: number][]): Swipe {
  return moves.reduce((swipe, [dx, dy]) => moveSwipe(swipe, X + dx, Y + dy), beginSwipe(X, Y));
}

describe('deciding which way a finger is going', () => {
  it('waits until it has moved far enough to say', () => {
    expect(through([-1, 0]).phase).toBe('deciding');
    expect(through([-(SWIPE_DECIDE_PX - 1), 0]).phase).toBe('deciding');
    expect(through([0, SWIPE_DECIDE_PX - 1]).phase).toBe('deciding');
    expect(through([-3, -3], [-5, 5]).phase).toBe('deciding');
  });

  it('takes a move to the left once it has', () => {
    const swipe = through([-SWIPE_DECIDE_PX, 0]);
    expect(swipe.phase).toBe('tracking');
    expect(swipe.offset).toBe(SWIPE_DECIDE_PX);
  });

  it('leaves a move up or down to the list, for good', () => {
    for (const dy of [SWIPE_DECIDE_PX, -SWIPE_DECIDE_PX, 200]) {
      const swipe = through([0, dy]);
      expect(swipe.phase, String(dy)).toBe('abandoned');
      expect(endSwipe(swipe)).toBe('nothing');
    }
    expect(through([0, 12], [-200, 12]).phase).toBe('abandoned');
    expect(through([0, 12], [-200, 12]).offset).toBe(0);
  });

  it('calls a diagonal vertical unless it is clearly sideways', () => {
    expect(through([-12, 12]).phase).toBe('abandoned');
    expect(through([-12, 13]).phase).toBe('abandoned');
    expect(through([-12, 11]).phase).toBe('tracking');
  });

  it('leaves a move to the right alone, because it means nothing here', () => {
    expect(through([SWIPE_DECIDE_PX, 0]).phase).toBe('abandoned');
    expect(through([40, 2], [-100, 2]).phase).toBe('abandoned');
  });
});

describe('following the finger', () => {
  it('moves with it up to the point of arming', () => {
    const swipe = through([-40, 3]);
    expect(swipe.offset).toBe(40);
    expect(swipe.armed).toBe(false);
  });

  it('is armed from exactly the threshold', () => {
    expect(through([-(SWIPE_ARM_PX - 1), 0]).armed).toBe(false);
    expect(through([-SWIPE_ARM_PX, 0]).armed).toBe(true);
  });

  it('pulls harder past the threshold, and then not at all', () => {
    expect(swipeOffset(SWIPE_ARM_PX)).toBe(SWIPE_ARM_PX);
    expect(swipeOffset(SWIPE_ARM_PX + 40)).toBe(SWIPE_ARM_PX + 10);
    expect(swipeOffset(5000)).toBe(SWIPE_MAX_PX);
    expect(swipeOffset(-20)).toBe(0);
  });

  it('can be taken back, past the threshold and past where it began', () => {
    const armed = through([-20, 0], [-80, 0]);
    expect(armed.armed).toBe(true);
    const undone = moveSwipe(armed, X - 30, Y);
    expect(undone.armed).toBe(false);
    expect(undone.offset).toBe(30);
    const past = moveSwipe(armed, X + 50, Y);
    expect(past.offset).toBe(0);
    expect(past.armed).toBe(false);
  });

  it('keeps following when the finger drifts down, once it is under way', () => {
    const swipe = through([-20, 2], [-80, 60]);
    expect(swipe.phase).toBe('tracking');
    expect(swipe.armed).toBe(true);
  });
});

describe('letting go', () => {
  it('starts a reply when armed', () => {
    expect(endSwipe(through([-20, 0], [-SWIPE_ARM_PX, 0]))).toBe('reply');
  });

  it('springs back when not', () => {
    expect(endSwipe(through([-20, 0], [-(SWIPE_ARM_PX - 1), 0]))).toBe('spring');
  });

  it('does nothing for a tap, which never moved', () => {
    expect(endSwipe(beginSwipe(X, Y))).toBe('nothing');
    expect(endSwipe(through([-2, 1]))).toBe('nothing');
  });

  it('never replies on a second finger, or when the browser takes over, however far it got', () => {
    expect(cancelSwipe(through([-20, 0], [-90, 0]))).toBe('spring');
    expect(cancelSwipe(through([-2, 0]))).toBe('nothing');
    expect(cancelSwipe(through([0, 40]))).toBe('nothing');
  });
});

describe('a long press', () => {
  it('survives a finger that wobbles', () => {
    expect(pressHeld(X, Y, X, Y)).toBe(true);
    expect(pressHeld(X, Y, X + LONG_PRESS_SLOP_PX, Y)).toBe(true);
    expect(pressHeld(X, Y, X + 6, Y + 6)).toBe(true);
  });

  it('is over once the finger has moved further than that, in any direction', () => {
    expect(pressHeld(X, Y, X + LONG_PRESS_SLOP_PX + 1, Y)).toBe(false);
    expect(pressHeld(X, Y, X, Y - LONG_PRESS_SLOP_PX - 1)).toBe(false);
    expect(pressHeld(X, Y, X + 8, Y + 8)).toBe(false);
  });
});
