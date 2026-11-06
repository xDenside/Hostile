import { useRef, useState, type ChangeEvent } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import {
  AVATAR_COLORS,
  LIMITS,
  NAME_EFFECTS,
  NAME_FONTS,
  PROFILE_IMAGE_TYPES,
  type NameEffect,
  type NameFont,
  type ProfileMediaKind,
} from '@hostile/shared';
import { endpoints, errorMessage } from '../../api/client';
import { Avatar, Button, cx, Field, TextInput } from '../../components/ui';
import { useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/ui';
import { Group } from '../settings/Group';
import settings from '../settings/settings.module.scss';
import { NAME_EFFECT_LABELS, NAME_FONT_LABELS } from './fonts';
import { NameText, OwnerMark } from './NameText';
import { ProfileBanner, StatusChip } from './Popups';
import styles from './profile.module.scss';

const LIMIT_FOR: Record<ProfileMediaKind, number> = {
  avatar: LIMITS.avatarMaxBytes,
  banner: LIMITS.bannerMaxBytes,
};

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export function ProfileTab() {
  const self = useSession((s) => s.user!);
  const online = useCommunity((s) => !!s.online[self.id]);
  const [displayName, setDisplayName] = useState(self.displayName);
  const [avatarColor, setAvatarColor] = useState(self.avatarColor);
  const [nameFont, setNameFont] = useState<NameFont>(self.nameFont);
  const [nameEffect, setNameEffect] = useState<NameEffect>(self.nameEffect);
  const [nameColor, setNameColor] = useState(self.nameColor);
  const [nameColor2, setNameColor2] = useState(self.nameColor2);
  const [bannerColor, setBannerColor] = useState(self.bannerColor);
  const [customStatus, setCustomStatus] = useState(self.customStatus ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<ProfileMediaKind | null>(null);

  const dirty =
    displayName !== self.displayName ||
    avatarColor !== self.avatarColor ||
    nameFont !== self.nameFont ||
    nameEffect !== self.nameEffect ||
    nameColor !== self.nameColor ||
    nameColor2 !== self.nameColor2 ||
    bannerColor !== self.bannerColor ||
    customStatus.trim() !== (self.customStatus ?? '');

  const draft = {
    ...self,
    displayName: displayName || self.displayName,
    avatarColor,
    nameFont,
    nameEffect,
    nameColor,
    nameColor2,
    bannerColor,
    customStatus: customStatus.trim() || null,
  };

  async function save() {
    setSaving(true);
    try {
      const res = await endpoints.updateProfile({
        displayName,
        avatarColor: avatarColor as (typeof AVATAR_COLORS)[number],
        nameFont,
        nameEffect,
        nameColor,
        nameColor2,
        bannerColor,
        customStatus,
      });
      useSession.setState({ user: res.user });
      toast('Profile updated.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: ProfileMediaKind, file: File) {
    if (file.size > LIMIT_FOR[kind]) {
      toast(`That file is over the ${megabytes(LIMIT_FOR[kind])} limit.`, 'error');
      return;
    }
    setUploading(kind);
    try {
      const res = await endpoints.uploadProfileMedia(kind, file);
      useSession.setState({ user: res.user });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setUploading(null);
    }
  }

  async function remove(kind: ProfileMediaKind) {
    setUploading(kind);
    try {
      const res = await endpoints.removeProfileMedia(kind);
      useSession.setState({ user: res.user });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className={styles.editor}>
      <div className={styles.editorMedia}>
        <Group title="Avatar">
          <MediaControl
            kind="avatar"
            hasImage={!!self.avatarUrl}
            busy={uploading === 'avatar'}
            onUpload={upload}
            onRemove={remove}
          />
          <div className={settings.colors} role="radiogroup" aria-label="Avatar color">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={avatarColor === c}
                aria-label={`Color ${c}`}
                className={settings.colorDot}
                style={{
                  background: c,
                  outline: avatarColor === c ? '2px solid var(--text)' : undefined,
                }}
                onClick={() => setAvatarColor(c)}
              />
            ))}
          </div>
        </Group>

        <Group title="Profile background">
          <MediaControl
            kind="banner"
            hasImage={!!self.bannerUrl}
            busy={uploading === 'banner'}
            onUpload={upload}
            onRemove={remove}
          />
          <ColorChoice
            label="Background color"
            value={bannerColor}
            fallback={avatarColor}
            onChange={setBannerColor}
          />
        </Group>
      </div>

      <div className={cx(styles.card, styles.preview)} data-testid="profile-preview">
        <ProfileBanner user={draft} />
        <div className={styles.cardHead}>
          <div className={styles.cardAvatar}>
            <Avatar
              name={draft.displayName}
              color={avatarColor}
              src={self.avatarUrl}
              size={76}
              online={online}
              animate
            />
          </div>
          <div className={styles.cardIdentity}>
            <div className={styles.cardNameRow}>
              <div className={styles.cardName} title={draft.displayName}>
                <NameText user={draft} live />
              </div>
              {self.role === 'owner' && <OwnerMark />}
            </div>
            <div className={styles.cardMeta}>
              <StatusChip online={online} status={draft.customStatus} />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.editorForm}>
        <Group title="Status">
          <Field
            label="Custom status"
            hint="Your card says this instead of Online while you are online. Leave it empty for Online."
          >
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={customStatus}
                maxLength={LIMITS.customStatusMax}
                placeholder="Online"
                onChange={(e) => setCustomStatus(e.target.value)}
              />
            )}
          </Field>
        </Group>

        <Group title="Name">
          <Field label="Nickname" hint="People can share a nickname. It is how others see you.">
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={displayName}
                maxLength={LIMITS.displayNameMax}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
          <div className={styles.styleGrid} role="radiogroup" aria-label="Name font">
            {NAME_FONTS.map((font) => (
              <StyleOption
                key={font}
                label={NAME_FONT_LABELS[font]}
                checked={nameFont === font}
                onSelect={() => setNameFont(font)}
                user={{ ...draft, nameFont: font }}
              />
            ))}
          </div>
        </Group>

        <Group title="Highlight">
          <div className={styles.styleGrid} role="radiogroup" aria-label="Name highlight">
            {NAME_EFFECTS.map((effect) => (
              <StyleOption
                key={effect}
                label={NAME_EFFECT_LABELS[effect]}
                checked={nameEffect === effect}
                onSelect={() => setNameEffect(effect)}
                user={{ ...draft, nameEffect: effect }}
              />
            ))}
          </div>
          <div className={styles.colorRow}>
            <ColorChoice
              label="Name color"
              value={nameColor}
              fallback={avatarColor}
              onChange={setNameColor}
            />
            <ColorChoice
              label="Second color"
              value={nameColor2}
              fallback="#ffffff"
              onChange={setNameColor2}
            />
          </div>
        </Group>

        <div className={styles.saveBar} data-dirty={dirty || undefined}>
          <span className={settings.hint}>
            {dirty ? 'You have unsaved changes.' : 'All saved.'}
          </span>
          <Button
            variant="primary"
            busy={saving}
            disabled={!dirty || !displayName.trim()}
            onClick={() => void save()}
            data-testid="profile-save"
          >
            Save profile
          </Button>
        </div>
      </div>
    </div>
  );
}

export function MediaControl({
  kind,
  hasImage,
  busy,
  onUpload,
  onRemove,
}: {
  kind: ProfileMediaKind;
  hasImage: boolean;
  busy: boolean;
  onUpload: (kind: ProfileMediaKind, file: File) => Promise<void>;
  onRemove: (kind: ProfileMediaKind) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void onUpload(kind, file);
  }
  return (
    <div className={styles.mediaRow}>
      <input
        ref={input}
        type="file"
        hidden
        accept={PROFILE_IMAGE_TYPES.join(',')}
        onChange={chosen}
        data-testid={`upload-${kind}`}
      />
      <Button small busy={busy} onClick={() => input.current?.click()}>
        <ImageUp size={14} /> {hasImage ? 'Replace' : 'Upload'}
      </Button>
      {hasImage && (
        <Button small variant="ghost" disabled={busy} onClick={() => void onRemove(kind)}>
          <Trash2 size={14} /> Remove
        </Button>
      )}
      <span className={settings.hint}>
        PNG, JPEG, WebP or GIF, animated ones too, up to {megabytes(LIMIT_FOR[kind])}.
      </span>
    </div>
  );
}

function StyleOption({
  label,
  checked,
  onSelect,
  user,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  user: Parameters<typeof NameText>[0]['user'];
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={styles.styleOption}
      data-avatar-host=""
      onClick={onSelect}
    >
      <span className={styles.styleName}>
        <NameText user={user} />
      </span>
      <span className={styles.styleLabel}>{label}</span>
    </button>
  );
}

function ColorChoice({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | null;
  fallback: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className={styles.colorField}>
      <input
        type="color"
        value={value ?? fallback}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{label}</span>
      {value && (
        <Button
          small
          variant="ghost"
          onClick={(e) => {
            e.preventDefault();
            onChange(null);
          }}
        >
          Reset
        </Button>
      )}
    </label>
  );
}
