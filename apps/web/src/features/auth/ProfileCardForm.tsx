import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type ProfileMediaKind, type UserPublic } from '@hostile/shared';
import { Avatar, cx, Field, TextInput } from '../../components/ui';
import { ProfileBanner } from '../profile/Popups';
import { NameText, OwnerMark } from '../profile/NameText';
import { MediaControl } from '../profile/ProfileTab';
import profile from '../profile/profile.module.scss';
import styles from './auth.module.scss';

function useObjectUrl(file: File | null) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export function ProfileCardForm({
  nickname,
  avatar,
  banner,
  error,
  owner,
  onNickname,
  onPicture,
}: {
  nickname: string;
  avatar: File | null;
  banner: File | null;
  error?: string | null | undefined;
  owner?: boolean;
  onNickname: (value: string) => void;
  onPicture: (kind: ProfileMediaKind, file: File | null) => void;
}) {
  const avatarUrl = useObjectUrl(avatar);
  const bannerUrl = useObjectUrl(banner);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = nickname.trim() || 'Your nickname';
  const preview: UserPublic = {
    id: 'preview',
    displayName: shown,
    avatarColor: '#2e2e2e',
    role: owner ? 'owner' : 'member',
    disabled: false,
    avatarUrl,
    bannerUrl,
    bannerColor: null,
    nameFont: 'default',
    nameEffect: 'none',
    nameColor: null,
    nameColor2: null,
    customStatus: null,
  };

  const choose = (kind: ProfileMediaKind, file: File) => {
    const most = kind === 'avatar' ? LIMITS.avatarMaxBytes : LIMITS.bannerMaxBytes;
    if (file.size > most) {
      setProblem(`That image is too large. It can be up to ${most / (1024 * 1024)} MB.`);
      return Promise.resolve();
    }
    setProblem(null);
    onPicture(kind, file);
    return Promise.resolve();
  };
  const clear = (kind: ProfileMediaKind) => {
    onPicture(kind, null);
    return Promise.resolve();
  };

  return (
    <>
      <div className={cx(profile.card, styles.preview)} data-testid="ask-preview">
        <ProfileBanner user={preview} />
        <div className={profile.cardHead}>
          <div className={profile.cardAvatar}>
            <Avatar name={shown} color={preview.avatarColor} src={avatarUrl} size={76} animate />
          </div>
          <div className={profile.cardIdentity}>
            <div className={profile.cardNameRow}>
              <div className={profile.cardName} title={shown}>
                <NameText user={preview} live />
              </div>
              {owner && <OwnerMark />}
            </div>
          </div>
        </div>
      </div>
      <Field label="Nickname" error={error ?? problem ?? undefined}>
        {(id) => (
          <TextInput
            id={id}
            autoComplete="nickname"
            value={nickname}
            maxLength={LIMITS.displayNameMax}
            onChange={(e) => onNickname(e.target.value)}
            required
          />
        )}
      </Field>
      <div className={styles.picture}>
        <span className={styles.pictureLabel}>Avatar</span>
        <MediaControl
          kind="avatar"
          hasImage={!!avatar}
          busy={false}
          onUpload={choose}
          onRemove={clear}
        />
      </div>
      <div className={styles.picture}>
        <span className={styles.pictureLabel}>Profile background</span>
        <MediaControl
          kind="banner"
          hasImage={!!banner}
          busy={false}
          onUpload={choose}
          onRemove={clear}
        />
      </div>
    </>
  );
}
