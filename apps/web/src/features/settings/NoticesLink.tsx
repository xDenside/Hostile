import { useState } from 'react';
import { siteBase } from '../../tunnel/net';
import styles from './settings.module.scss';

export function NoticesLink() {
  const [text, setText] = useState<string | null>(null);
  return (
    <>
      <button
        className={styles.noticesLink}
        type="button"
        onClick={() => {
          if (text !== null) return setText(null);
          void fetch(`${siteBase()}/third-party-notices.txt`)
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
            .then(setText)
            .catch(() => setText('The notices file could not be read.'));
        }}
      >
        Third-party notices
      </button>
      {text !== null && (
        <pre className={styles.notices} data-testid="notices-text">
          {text}
        </pre>
      )}
    </>
  );
}
