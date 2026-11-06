import { lazy, Suspense, useEffect } from 'react';
import { MotionConfig } from 'motion/react';
import { BRAND } from '@hostile/shared';
import { UnreachableScreen } from './features/auth/AuthScreens';
import { AppShell } from './features/layout/AppShell';
import { Spinner, Toasts } from './components/ui';
import { boot, installConnectivityHooks } from './app/session';
import { useSession } from './stores/session';

const RoomChoiceScreen = lazy(() =>
  import('./features/auth/RoomChoice').then((m) => ({ default: m.RoomChoiceScreen })),
);
const AskScreen = lazy(() =>
  import('./features/auth/AskScreen').then((m) => ({ default: m.AskScreen })),
);
const JoinScreen = lazy(() =>
  import('./features/auth/JoinScreen').then((m) => ({ default: m.JoinScreen })),
);

export function App() {
  const status = useSession((s) => s.status);

  useEffect(() => {
    const dispose = installConnectivityHooks();
    void boot();
    return dispose;
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="window-drag" aria-hidden="true" />
      {status === 'booting' && (
        <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
          <Spinner label={`Starting ${BRAND.displayName}`} />
        </div>
      )}
      {status === 'room-choice' && (
        <Suspense fallback={null}>
          <RoomChoiceScreen />
        </Suspense>
      )}
      {status === 'join' && (
        <Suspense fallback={null}>
          <JoinScreen />
        </Suspense>
      )}
      {status === 'unreachable' && <UnreachableScreen />}
      {status === 'ask' && (
        <Suspense fallback={null}>
          <AskScreen />
        </Suspense>
      )}
      {status === 'signed-in' && <AppShell />}
      <Toasts />
    </MotionConfig>
  );
}
