import { useEffect, type FormEvent } from 'react';
import { BRAND } from '@hostile/shared';
import { askAgain, askToJoin, cancelAsking, resumeAsking, useAsk } from '../../app/ask';
import { Banner, Button, Logo, SpinnerLine } from '../../components/ui';
import { useSession } from '../../stores/session';
import { useTunnel } from '../../tunnel/state';
import { ProfileCardForm } from './ProfileCardForm';
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

export function AskScreen() {
  const ask = useAsk();
  const notice = useSession((s) => s.notice);
  const away = useTunnel((s) => s.phase === 'away');

  useEffect(() => resumeAsking(), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    useSession.setState({ notice: null });
    askToJoin();
  }

  if (ask.phase === 'waiting') {
    return (
      <main className={styles.screen}>
        <div className={styles.card} data-testid="ask-waiting">
          <Brand subtitle="The host needs to let you in" />
          <SpinnerLine label={`Waiting for the host, ${ask.nickname}`} />
          <p className={styles.quiet}>
            {away
              ? 'The host cannot be reached just now. You stay in line, and this carries on by itself.'
              : 'You can leave this open. It carries on by itself if the connection drops.'}
          </p>
          <Button wide onClick={cancelAsking}>
            Cancel
          </Button>
        </div>
      </main>
    );
  }

  if (ask.phase === 'turned-away' || ask.phase === 'no-answer') {
    return (
      <main className={styles.screen}>
        <div className={styles.card} data-testid={`ask-${ask.phase}`}>
          <Brand subtitle={ask.phase === 'turned-away' ? 'The host said no' : 'Nobody answered'} />
          <Banner kind="info">
            {ask.phase === 'turned-away'
              ? 'The host turned this request away. You can ask again.'
              : 'The host did not answer in time. You can ask again.'}
          </Banner>
          <Button variant="primary" wide onClick={askAgain}>
            Ask again
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <Brand subtitle="Choose how the room sees you" />
        {notice && <Banner kind="info">{notice}</Banner>}
        <form className={styles.form} onSubmit={submit} aria-label="Ask to join">
          <ProfileCardForm
            nickname={ask.nickname}
            avatar={ask.avatar}
            banner={ask.banner}
            error={ask.error}
            onNickname={(nickname) => useAsk.setState({ nickname, error: null })}
            onPicture={(kind, file) => useAsk.setState({ [kind]: file })}
          />
          <Button type="submit" variant="primary" wide disabled={!ask.nickname.trim()}>
            Ask to join
          </Button>
        </form>
      </div>
    </main>
  );
}
