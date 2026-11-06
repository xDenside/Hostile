export const SWIPE_DECIDE_PX = 10;
export const SWIPE_ARM_PX = 64;
const SWIPE_RESISTANCE = 0.25;
export const SWIPE_MAX_PX = 96;

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface Swipe {
  startX: number;
  startY: number;
  phase: 'deciding' | 'tracking' | 'abandoned';
  offset: number;
  armed: boolean;
}

export function beginSwipe(x: number, y: number): Swipe {
  return { startX: x, startY: y, phase: 'deciding', offset: 0, armed: false };
}

export function swipeOffset(pulled: number): number {
  if (pulled <= SWIPE_ARM_PX) return Math.max(0, pulled);
  return Math.min(SWIPE_MAX_PX, SWIPE_ARM_PX + (pulled - SWIPE_ARM_PX) * SWIPE_RESISTANCE);
}

export function moveSwipe(swipe: Swipe, x: number, y: number): Swipe {
  if (swipe.phase === 'abandoned') return swipe;
  const dx = x - swipe.startX;
  const dy = y - swipe.startY;
  if (swipe.phase === 'deciding') {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_DECIDE_PX) return swipe;
    if (dx >= 0 || Math.abs(dy) >= Math.abs(dx)) return { ...swipe, phase: 'abandoned' };
  }
  const pulled = -dx;
  return {
    ...swipe,
    phase: 'tracking',
    offset: swipeOffset(pulled),
    armed: pulled >= SWIPE_ARM_PX,
  };
}

export function endSwipe(swipe: Swipe): 'reply' | 'spring' | 'nothing' {
  if (swipe.phase !== 'tracking') return 'nothing';
  return swipe.armed ? 'reply' : 'spring';
}

export function cancelSwipe(swipe: Swipe): 'spring' | 'nothing' {
  return swipe.phase === 'tracking' ? 'spring' : 'nothing';
}

export function pressHeld(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) <= LONG_PRESS_SLOP_PX;
}
