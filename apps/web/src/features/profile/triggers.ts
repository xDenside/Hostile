import type { MouseEvent } from 'react';
import { openPopup } from '../../stores/ui';

const CARD_WIDTH = 320;

export function memberTrigger(userId: string) {
  return {
    'data-avatar-host': '',
    onClick: (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      const box = e.currentTarget.getBoundingClientRect();
      const fitsRight = box.right + CARD_WIDTH + 16 <= window.innerWidth;
      const x = fitsRight ? box.right + 8 : box.left - CARD_WIDTH - 8;
      openPopup({ kind: 'profile', userId, x, y: box.top });
    },
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      openPopup({ kind: 'member-menu', userId, x: e.clientX, y: e.clientY });
    },
  };
}
