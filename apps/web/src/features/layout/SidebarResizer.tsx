import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampSidebarWidth, SIDEBAR_WIDTH, useUi } from '../../stores/ui';
import styles from './layout.module.scss';

const KEY_STEP = 16;

const apply = (width: number) =>
  document.documentElement.style.setProperty('--sidebar-pref', `${width}px`);

export function SidebarResizer() {
  const saved = useUi((s) => s.sidebarWidth);
  const [dragged, setDragged] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const width = dragged ?? saved;

  useEffect(() => apply(width), [width]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const startWidth = e.currentTarget.parentElement!.getBoundingClientRect().width;
    drag.current = { startX: e.clientX, startWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.startWidth + e.clientX - drag.current.startX;
    setDragged(clampSidebarWidth(next, window.innerWidth));
  };

  const endDrag = () => {
    drag.current = null;
    if (dragged === null) return;
    useUi.setState({ sidebarWidth: dragged });
    setDragged(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: width - KEY_STEP,
      ArrowRight: width + KEY_STEP,
      Home: SIDEBAR_WIDTH.min,
      End: SIDEBAR_WIDTH.max,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    useUi.setState({ sidebarWidth: clampSidebarWidth(next, window.innerWidth) });
  };

  return (
    <div
      className={styles.sidebarResizer}
      role="separator"
      aria-orientation="vertical"
      aria-label="Channel list width"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-testid="sidebar-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => useUi.setState({ sidebarWidth: SIDEBAR_WIDTH.default })}
    />
  );
}
