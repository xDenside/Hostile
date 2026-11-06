import { useEffect, useRef, type CSSProperties } from 'react';
import { BadgeCheck } from 'lucide-react';
import type { NameEffect, NameFont } from '@hostile/shared';
import { cx } from '../../components/ui';
import './fonts';
import styles from './name.module.scss';

const capitalized = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

let visibility: IntersectionObserver | null = null;

function pauseOffScreen(name: Element): () => void {
  visibility ??= new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      target.toggleAttribute('data-off-screen', !isIntersecting);
    }
  });
  visibility.observe(name);
  return () => visibility?.unobserve(name);
}

export interface NameStyle {
  displayName: string;
  nameFont?: NameFont;
  nameEffect?: NameEffect;
  nameColor?: string | null;
  nameColor2?: string | null;
}

export function NameText({
  user,
  live,
  className,
}: {
  user: NameStyle | undefined;
  live?: boolean;
  className?: string;
}) {
  const effect = user?.nameEffect ?? 'none';
  const font = user?.nameFont ?? 'default';
  const name = user?.displayName ?? 'Unknown';
  const animated = !!live && effect !== 'none';
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (animated && element.current) return pauseOffScreen(element.current);
  }, [animated]);
  const style = {
    ...(user?.nameColor ? { '--name-c1': user.nameColor } : {}),
    ...(user?.nameColor2 ? { '--name-c2': user.nameColor2 } : {}),
  } as CSSProperties;
  return (
    <span
      ref={element}
      className={cx(
        styles.name,
        styles[`font${capitalized(font)}`],
        styles[`effect${capitalized(effect)}`],
        effect === 'none' && user?.nameColor && styles.solid,
        live && styles.live,
        className,
      )}
      style={style}
      data-text={name}
    >
      {name}
    </span>
  );
}

export function OwnerMark({ className }: { className?: string }) {
  return (
    <span
      className={cx(styles.ownerMark, className)}
      role="img"
      aria-label="Owner"
      title="Owner"
      data-testid="owner-mark"
    >
      <BadgeCheck aria-hidden />
    </span>
  );
}
