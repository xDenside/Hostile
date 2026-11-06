import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button, IconButton } from '../../components/ui';
import styles from './settings.module.scss';

export function Group({
  title,
  hint,
  action,
  children,
}: {
  title?: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHead}>
        <div className={styles.groupTitles}>
          {title && <h3 className={styles.heading}>{title}</h3>}
          {hint && <p className={styles.groupHint}>{hint}</p>}
        </div>
        {action}
      </header>
      <div className={styles.groupBody}>{children}</div>
    </section>
  );
}

export function ConfirmButton({
  label,
  icon,
  question,
  onConfirm,
}: {
  label: string;
  icon?: ReactNode;
  question: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (asking) cancel.current?.focus();
    else if (asked.current) trigger.current?.focus();
    asked.current = asking;
  }, [asking]);

  if (!asking) {
    return icon ? (
      <IconButton ref={trigger} label={label} icon={icon} onClick={() => setAsking(true)} />
    ) : (
      <Button ref={trigger} small variant="dangerQuiet" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span
      className={styles.confirm}
      data-own-escape
      role="group"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setAsking(false);
      }}
    >
      <span className={styles.confirmQuestion}>{question}</span>
      <Button ref={cancel} small variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
      <Button
        small
        variant="danger"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {label}
      </Button>
    </span>
  );
}

const COPIED_MS = 1800;

export function CodeReveal({
  title,
  code,
  note,
  onCopy,
  onDismiss,
}: {
  title: string;
  code: string;
  note?: ReactNode;
  onCopy: (code: string) => Promise<void>;
  onDismiss?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className={styles.reveal} role="status">
      <div className={styles.revealHead}>
        <span>{title}</span>
        {onDismiss && <IconButton label="Dismiss" icon={<X size={15} />} onClick={onDismiss} />}
      </div>
      <div className={styles.revealCode}>
        <div className={styles.secret}>{code}</div>
        <Button
          onClick={async () => {
            await onCopy(code);
            setCopied(true);
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {note && <p className={styles.hint}>{note}</p>}
    </div>
  );
}
