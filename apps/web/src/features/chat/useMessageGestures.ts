import { useCallback, useEffect, useMemo, useRef, type TouchEvent } from 'react';
import { openMessageMenu, rowOf } from './message-actions';
import { startReply, useChat } from './store';
import {
  beginSwipe,
  cancelSwipe,
  endSwipe,
  LONG_PRESS_MS,
  moveSwipe,
  pressHeld,
  SWIPE_ARM_PX,
  type Swipe,
} from './swipe';

const RIGHT_EDGE_PX = 20;
const SPRING_MS = 260;
const CLICK_AFTER_LIFT_MS = 350;

interface Gesture {
  row: HTMLElement;
  finger: number;
  startX: number;
  startY: number;
  swipe: Swipe | null;
  pressTimer: ReturnType<typeof setTimeout> | null;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const scrollsSideways = (target: Element): boolean => {
  const code = target.closest('pre');
  return !!code && code.scrollWidth > code.clientWidth;
};

export function useMessageGestures(channelId: string) {
  const icon = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const stopSwallowing = useRef<(() => void) | null>(null);

  const hideIcon = useCallback(() => {
    const node = icon.current;
    if (!node) return;
    node.style.opacity = '';
    node.removeAttribute('data-armed');
  }, []);

  const drawIcon = useCallback((row: HTMLElement, swipe: Swipe) => {
    const node = icon.current;
    const parent = node?.offsetParent;
    if (!node || !parent) return;
    const box = parent.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const list = row.closest('[role="log"]')?.getBoundingClientRect() ?? box;
    const top = Math.max(rowBox.top, list.top);
    const bottom = Math.min(rowBox.bottom, list.bottom);
    node.style.top = `${(top + bottom) / 2 - box.top - node.offsetHeight / 2}px`;
    node.style.opacity = `${Math.min(1, swipe.offset / SWIPE_ARM_PX)}`;
    node.toggleAttribute('data-armed', swipe.armed);
  }, []);

  const springBack = useCallback(
    (row: HTMLElement) => {
      hideIcon();
      if (reducedMotion()) {
        row.style.transform = '';
        row.style.transition = '';
        row.style.willChange = '';
        return;
      }
      row.style.transition = `transform ${SPRING_MS}ms var(--ease-spring)`;
      row.style.transform = '';
      const done = () => {
        clearTimeout(timer);
        row.removeEventListener('transitionend', onEnd);
        row.style.transition = '';
        row.style.willChange = '';
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.target === row) done();
      };
      row.addEventListener('transitionend', onEnd);
      const timer = setTimeout(done, SPRING_MS + 60);
    },
    [hideIcon],
  );

  const cancelPress = useCallback(() => {
    const current = gesture.current;
    if (!current?.pressTimer) return;
    clearTimeout(current.pressTimer);
    current.pressTimer = null;
  }, []);

  const swallowNextClick = useCallback(() => {
    stopSwallowing.current?.();
    let liftedAlready = false;
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (liftedAlready) stop();
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lifted = () => {
      liftedAlready = true;
      timer = setTimeout(stop, CLICK_AFTER_LIFT_MS);
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('touchend', lifted, true);
      window.removeEventListener('touchcancel', lifted, true);
      window.removeEventListener('touchstart', stop, true);
      stopSwallowing.current = null;
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('touchend', lifted, true);
    window.addEventListener('touchcancel', lifted, true);
    window.addEventListener('touchstart', stop, true);
    stopSwallowing.current = stop;
  }, []);

  const finishSwipe = useCallback(
    (current: Gesture, release: boolean) => {
      const { swipe, row } = current;
      if (!swipe) return;
      const outcome = release ? endSwipe(swipe) : cancelSwipe(swipe);
      current.swipe = null;
      if (outcome === 'nothing') return;
      springBack(row);
      if (outcome !== 'reply') return;
      const message = useChat
        .getState()
        .windows[channelId]?.messages.find((m) => m.id === row.dataset.messageId);
      if (message) startReply(message);
    },
    [channelId, springBack],
  );

  useEffect(
    () => () => {
      const current = gesture.current;
      if (current?.pressTimer) clearTimeout(current.pressTimer);
      gesture.current = null;
      stopSwallowing.current?.();
    },
    [],
  );

  const handlers = useMemo(
    () => ({
      onTouchStart: (e: TouchEvent<HTMLElement>) => {
        const current = gesture.current;
        if (current) {
          cancelPress();
          finishSwipe(current, false);
          if (e.touches.length > 1) return;
        }
        gesture.current = null;
        if (e.touches.length !== 1) return;
        const target = e.target as Element;
        const row = rowOf(target);
        if (!row || row.dataset.editing !== undefined) return;
        if (target.closest('textarea, input, [data-row-actions]')) return;
        const touch = e.touches[0]!;
        const { clientX: x, clientY: y } = touch;
        const started: Gesture = {
          row,
          finger: touch.identifier,
          startX: x,
          startY: y,
          swipe:
            !target.closest('video') &&
            !scrollsSideways(target) &&
            x < window.innerWidth - RIGHT_EDGE_PX
              ? beginSwipe(x, y)
              : null,
          pressTimer: null,
        };
        if (!target.closest('a, [data-avatar-host]')) {
          started.pressTimer = setTimeout(() => {
            started.pressTimer = null;
            started.swipe = null;
            swallowNextClick();
            openMessageMenu(channelId, row, x, y, target);
          }, LONG_PRESS_MS);
        }
        gesture.current = started;
      },

      onTouchMove: (e: TouchEvent<HTMLElement>) => {
        const current = gesture.current;
        const touch = Array.from(e.touches).find((t) => t.identifier === current?.finger);
        if (!current || !touch) return;
        if (e.touches.length > 1) {
          cancelPress();
          finishSwipe(current, false);
          return;
        }
        const { clientX: x, clientY: y } = touch;
        if (current.pressTimer && !pressHeld(current.startX, current.startY, x, y)) cancelPress();
        if (!current.swipe) return;
        const next = moveSwipe(current.swipe, x, y);
        const wasArmed = current.swipe.armed;
        current.swipe = next;
        if (next.phase !== 'tracking') return;
        cancelPress();
        const { row } = current;
        row.style.willChange = 'transform';
        row.style.transition = 'none';
        row.style.transform = `translateX(${-next.offset}px)`;
        drawIcon(row, next);
        if (next.armed && !wasArmed) navigator.vibrate?.(10);
      },

      onTouchEnd: (e: TouchEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current) return;
        const lifted = Array.from(e.changedTouches).some((t) => t.identifier === current.finger);
        if (!lifted) return;
        cancelPress();
        finishSwipe(current, e.touches.length === 0);
        gesture.current = null;
      },

      onTouchCancel: () => {
        const current = gesture.current;
        if (!current) return;
        cancelPress();
        finishSwipe(current, false);
        gesture.current = null;
      },
    }),
    [cancelPress, channelId, drawIcon, finishSwipe, swallowNextClick],
  );

  const pressOpenedMenu = useCallback((): boolean => {
    const current = gesture.current;
    if (!current) return false;
    cancelPress();
    finishSwipe(current, false);
    swallowNextClick();
    return true;
  }, [cancelPress, finishSwipe, swallowNextClick]);

  return { handlers, cancelPress, pressOpenedMenu, icon };
}
