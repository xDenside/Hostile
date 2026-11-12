import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ChevronDown, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { mediaUrl } from '../api/client';
import { useFilesBlocked } from '../features/chat/files-blocked';
import { stillFrame } from '../lib/still-frame';
import { dismissToast, useUi } from '../stores/ui';
import styles from './ui.module.scss';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'dangerQuiet' | 'ghost';

export function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg
      className={styles.logo}
      viewBox="0 0 480 480"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
    >
      <path d="M72 0h336a72 72 0 0 1 72 72v152A256 256 0 0 0 224 480H72a72 72 0 0 1-72-72V72A72 72 0 0 1 72 0z" />
      <circle cx="396" cy="396" r="84" />
    </svg>
  );
}

export function Button({
  variant = 'secondary',
  small,
  wide,
  className,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  small?: boolean;
  wide?: boolean;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className={cx(
        styles.button,
        styles[variant],
        small && styles.small,
        wide && styles.wide,
        className,
      )}
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className={styles.spinner} aria-hidden /> : null}
      {children}
    </button>
  );
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    icon: ReactNode;
    tone?: 'default' | 'danger' | 'active';
    tipBelow?: boolean;
    pressed?: boolean;
  }
>(function IconButton(
  { label, icon, tone = 'default', tipBelow, pressed, className, ...rest },
  ref,
) {
  return (
    <span className={styles.iconWrap}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={cx(
          styles.iconButton,
          tone === 'danger' && styles.iconDanger,
          tone === 'active' && styles.iconActive,
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
      <span className={cx(styles.tip, tipBelow && styles.tipBottom)} aria-hidden>
        {label}
      </span>
    </span>
  );
});

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .map((word) => Array.from(word).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));
  if (!words.length) return '';
  const picked = words.length > 1 ? [words[0]!, words[words.length - 1]!] : [words[0]!];
  return picked.join('').slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  color,
  size = 32,
  speaking,
  online,
  src,
  animate,
}: {
  name: string;
  color: string;
  size?: number;
  speaking?: boolean;
  online?: boolean;
  src?: string | null;
  animate?: boolean;
}) {
  const text = initials(name) || '?';
  const url = src ? mediaUrl(src) : null;
  const filesBlocked = useFilesBlocked();
  const failKey = url && `${filesBlocked}:${url}`;
  const [failed, setFailed] = useState<string | null>(null);
  const [still, setStill] = useState<{ url: string; frame: string | null } | null>(null);
  useEffect(() => {
    if (!url || animate || filesBlocked) return;
    let alive = true;
    void stillFrame(url).then((frame) => {
      if (alive) setStill({ url, frame });
    });
    return () => {
      alive = false;
    };
  }, [url, animate, filesBlocked]);
  const showImage = !!url && failed !== failKey;
  const frame = !animate && still?.url === url ? still.frame : null;
  const dot = Math.min(16, Math.max(10, Math.round(size * 0.26)));
  const dotInset = (size / 2) * (1 - Math.SQRT1_2) - dot / 2;
  return (
    <span
      className={cx(styles.avatar, speaking && styles.speaking)}
      style={{
        width: size,
        height: size,
        minWidth: size,
        flex: 'none',
        background: color,
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden
    >
      {showImage ? (
        <>
          {frame && <img className={styles.avatarImage} src={frame} alt="" draggable={false} />}
          <img
            key={String(filesBlocked)}
            className={cx(styles.avatarImage, frame && styles.avatarLive)}
            src={url}
            alt=""
            draggable={false}
            onError={() => setFailed(failKey)}
          />
        </>
      ) : (
        text
      )}
      {online !== undefined && (
        <span
          className={cx(styles.presence, online && styles.online)}
          style={{ width: dot, height: dot, right: dotInset, bottom: dotInset }}
          data-testid="presence-dot"
        />
      )}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children(id, hint || error ? hintId : undefined)}
      {error ? (
        <span id={hintId} className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(styles.input, className)} {...rest} />;
  },
);

export function Select({
  value,
  onChange,
  options,
  id,
  disabled,
  testId,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  id?: string;
  disabled?: boolean;
  testId?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <span className={styles.selectWrap}>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className={styles.selectIcon} aria-hidden />
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className={styles.switchRow}>
      <div>
        <div id={id}>{label}</div>
        {description ? <div className={styles.hint}>{description}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className={styles.switch}
        disabled={disabled}
        data-testid={testId}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={styles.slider}
      style={{ '--fill': `${fill}%` } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={format ? format(value) : undefined}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className={styles.spinner} role="status" aria-label={label} />;
}

export function SpinnerLine({ label }: { label: string }) {
  return (
    <div className={styles.spinnerLine} role="status">
      <span className={styles.spinner} aria-hidden />
      <span className={styles.spinnerWords} title={label}>
        {label}
      </span>
    </div>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'warning' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        styles.banner,
        kind === 'error' && styles.bannerError,
        kind === 'warning' && styles.bannerWarning,
        kind === 'info' && styles.bannerInfo,
      )}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}

export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(
      'input:not([data-no-autofocus]), select, textarea, button:not([data-close])',
    );
    const unprompted = navigator.userActivation?.hasBeenActive === false;
    (unprompted ? node : (first ?? node))?.focus();
    return () => previous?.focus?.({ preventScroll: true });
  }, [ref]);

  useEffect(() => {
    const node = ref.current;
    const onKey = (e: KeyboardEvent) => {
      if (useUi.getState().capturingKeys) return;
      if (e.key === 'Escape' && e.target instanceof Element) {
        if (e.target.closest('[data-own-escape]')) return;
      }
      if (e.key === 'Escape' && !e.repeat) {
        e.stopPropagation();
        onCloseRef.current();
      }
      if (e.key === 'Tab' && node) {
        const focusable = Array.from(
          node.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (!focusable.length) return;
        const firstEl = focusable[0]!;
        const lastEl = focusable[focusable.length - 1]!;
        if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === node)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
}

export function Modal({
  title,
  onClose,
  children,
  width,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(ref, onClose);

  return (
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={ref}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.8 }}
      >
        <div className={styles.modalHeader}>
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close" icon={<X size={18} />} onClick={onClose} data-close tipBelow />
        </div>
        <div className={styles.modalBody}>{children}</div>
      </motion.div>
    </motion.div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className={styles.toasts} aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={cx(
              styles.toast,
              t.kind === 'error' && styles.toastError,
              t.kind === 'success' && styles.toastSuccess,
            )}
            initial={{ opacity: 0, x: 28, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 28, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0, right: 0.8 }}
            onDragEnd={(_e, info) => {
              if (info.offset.x > 90 || info.velocity.x > 600) dismissToast(t.id);
            }}
          >
            {t.text}
            <span
              className={styles.toastFuse}
              style={{ animationDuration: `${t.ttlMs}ms` }}
              aria-hidden
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export { cx, styles as uiStyles };
