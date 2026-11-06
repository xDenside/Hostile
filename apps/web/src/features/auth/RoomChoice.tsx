import { useState, type FormEvent } from 'react';
import { displayNameSchema } from '@hostile/shared';
import { Banner, Button, Logo } from '../../components/ui';
import { desktopRoom, platform } from '../../platform';
import { ProfileCardForm } from './ProfileCardForm';
import styles from './auth.module.scss';

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className={styles.brand}>
      <Logo size={32} />
      <div>
        <h1>Hostile</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

export function RoomChoiceScreen() {
  const bridge = platform().desktop!;
  const ownerless = desktopRoom()?.role === 'host';
  const [settingUp, setSettingUp] = useState(ownerless);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function host() {
    if (!desktopRoom()?.ownerExists) return setSettingUp(true);
    setBusy(true);
    setError(null);
    const started = await bridge.room.host();
    if (!started.ok) {
      setBusy(false);
      if (!(await bridge.room.get()).ownerExists) return setSettingUp(true);
      setError(started.error);
    }
  }

  if (settingUp) {
    return (
      <HostSetup onBack={() => (ownerless ? void bridge.room.leave() : setSettingUp(false))} />
    );
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <Brand subtitle="Host a room from this PC, or join someone's" />
        {error && <Banner kind="error">{error}</Banner>}
        <div className={styles.form}>
          <Button variant="primary" wide busy={busy} onClick={() => void host()}>
            Host a room
          </Button>
          <Button wide disabled={busy} onClick={() => void bridge.room.join()}>
            Join with a code
          </Button>
        </div>
      </div>
    </main>
  );
}

function HostSetup({ onBack }: { onBack: () => void }) {
  const bridge = platform().desktop!;
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(nickname);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setError(null);
    setBusy(true);
    const started = await bridge.room.host({
      displayName: parsed.data,
      ...(avatar ? { avatar: await avatar.arrayBuffer() } : {}),
      ...(banner ? { banner: await banner.arrayBuffer() } : {}),
    });
    if (!started.ok) {
      setError(started.error);
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <Brand subtitle="Choose how the room sees you" />
        <form className={styles.form} onSubmit={submit} aria-label="Create your room">
          <ProfileCardForm
            nickname={nickname}
            avatar={avatar}
            banner={banner}
            error={error}
            owner
            onNickname={setNickname}
            onPicture={(kind, file) => (kind === 'avatar' ? setAvatar(file) : setBanner(file))}
          />
          <Button type="submit" variant="primary" wide busy={busy} disabled={!nickname.trim()}>
            Create my room
          </Button>
        </form>
        <div className={styles.links}>
          <button className={styles.link} type="button" onClick={onBack} disabled={busy}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
