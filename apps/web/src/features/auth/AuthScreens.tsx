import { useState } from 'react';
import { BRAND } from '@hostile/shared';
import { boot } from '../../app/session';
import { Banner, Button, Logo } from '../../components/ui';
import { desktopRoom, platform } from '../../platform';
import { useSession } from '../../stores/session';
import styles from './auth.module.scss';

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className={styles.brand}>
      <Logo size={32} />
      <div>
        <h1>{BRAND.displayName}</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function HostFailedScreen({ message }: { message: string }) {
  const bridge = platform().desktop!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(message);
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <Brand subtitle="Your room did not start" />
        <Banner kind="warning">{error}</Banner>
        <Button
          variant="primary"
          wide
          busy={busy}
          onClick={async () => {
            setBusy(true);
            const started = await bridge.room.host();
            if (!started.ok) {
              setError(started.error);
              setBusy(false);
            }
          }}
        >
          Try again
        </Button>
        <div className={styles.links}>
          <button
            className={styles.link}
            type="button"
            disabled={busy}
            onClick={() => void bridge.room.leave()}
          >
            Back to the first screen
          </button>
        </div>
      </div>
    </main>
  );
}

export function UnreachableScreen() {
  const bootError = useSession((s) => s.bootError);
  const [busy, setBusy] = useState(false);
  const hostError = desktopRoom()?.hostError;
  if (hostError) return <HostFailedScreen message={hostError} />;
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <Brand subtitle="The host is not reachable right now" />
        <Banner kind="warning">
          {bootError ?? 'Cannot reach the host.'} Who you are here is kept; nothing was lost.
        </Banner>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          Check that your network allows the connection. Settings → Diagnostics has more detail once
          connected.
        </p>
        <Button
          variant="primary"
          wide
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await boot();
            setBusy(false);
          }}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
