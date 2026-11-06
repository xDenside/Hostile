import { useEffect, useState, type FormEvent } from 'react';
import { BRAND } from '@hostile/shared';
import { boot } from '../../app/session';
import { Banner, Button, Field, Logo, SpinnerLine, TextInput } from '../../components/ui';
import { platform } from '../../platform';
import { connectWithCode, forgetRoom, setCustomRelay } from '../../tunnel/guest';
import { JOIN_STEP_LABEL, useTunnel } from '../../tunnel/state';
import styles from './auth.module.scss';

function useSecondsUntil(when: number | null) {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (when === null) return;
    const read = () => setSeconds(Math.max(0, Math.ceil((when - Date.now()) / 1000)));
    const first = setTimeout(read, 0);
    const timer = setInterval(read, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [when]);
  return when === null ? null : seconds;
}

export function JoinScreen() {
  const tunnel = useTunnel();
  const [typed, setTyped] = useState<string | null>(null);
  const code = typed ?? tunnel.code ?? '';
  const [relayOpen, setRelayOpen] = useState(!!tunnel.customRelay);
  const seconds = useSecondsUntil(tunnel.retryAt);
  const connecting = tunnel.phase === 'connecting';
  const showRelay =
    tunnel.failedStep === 'meeting-point' || tunnel.failedStep === 'direct' || relayOpen;

  useEffect(() => {
    if (tunnel.phase === 'connected') void boot();
  }, [tunnel.phase]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void connectWithCode(code);
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <Logo size={32} />
          <div>
            <h1>{BRAND.displayName}</h1>
            <p>Paste the code from the person hosting</p>
          </div>
        </div>
        {tunnel.phase === 'failed' && tunnel.failedStep && (
          <Banner kind="error">
            <span data-testid="join-failed" data-step={tunnel.failedStep}>
              {JOIN_STEP_LABEL[tunnel.failedStep]} failed. {tunnel.message}
              {seconds !== null ? ` Trying again in ${seconds} s.` : ''}
            </span>
          </Banner>
        )}
        {tunnel.phase === 'ended' && (
          <Banner kind="error">
            <span data-testid="join-ended">{tunnel.message}</span>
          </Banner>
        )}
        {tunnel.phase === 'away' && (
          <Banner kind="warning">
            <span data-testid="join-away">{tunnel.message}</span>
          </Banner>
        )}
        <form className={styles.form} onSubmit={submit} aria-label="Join a room">
          <Field label="Room code">
            {(id) => (
              <TextInput
                id={id}
                className={styles.code}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={code}
                onChange={(e) => setTyped(e.target.value)}
                required
              />
            )}
          </Field>
          {showRelay && (
            <Field
              label="A relay of your own"
              hint="Optional. A turn: address carries the connection, a wss: address replaces the meeting point. This project runs none."
            >
              {(id, desc) => (
                <TextInput
                  id={id}
                  aria-describedby={desc}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={tunnel.customRelay}
                  onChange={(e) => setCustomRelay(e.target.value)}
                />
              )}
            </Field>
          )}
          {connecting && tunnel.step && (
            <div data-testid="join-step" data-step={tunnel.step}>
              <SpinnerLine label={`${JOIN_STEP_LABEL[tunnel.step]}…`} />
            </div>
          )}
          <Button type="submit" variant="primary" wide disabled={connecting || !code.trim()}>
            {tunnel.phase === 'failed' ? 'Try again' : 'Connect'}
          </Button>
        </form>
        <div className={styles.links}>
          {!showRelay && (
            <button className={styles.link} type="button" onClick={() => setRelayOpen(true)}>
              Use a relay of my own
            </button>
          )}
          {(tunnel.phase === 'failed' || tunnel.phase === 'ended' || connecting) && (
            <button
              className={styles.link}
              type="button"
              onClick={() => {
                forgetRoom();
                setTyped('');
              }}
            >
              Use a different code
            </button>
          )}
          {platform().desktop && (
            <button
              className={styles.link}
              type="button"
              onClick={() => {
                forgetRoom();
                void platform().desktop!.room.leave();
              }}
            >
              Back
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
