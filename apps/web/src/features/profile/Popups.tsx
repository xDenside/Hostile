import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  AudioLines,
  Copy,
  Download,
  Forward,
  Maximize2,
  Minimize2,
  MonitorOff,
  Pencil,
  Reply,
  ShieldCheck,
  Trash2,
  UserRound,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { UserPublic } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { Avatar, Button, cx, Slider, Switch } from '../../components/ui';
import { NO_PARTICIPANTS, useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import {
  closePopup,
  openPopup,
  useUi,
  type MemberPopup,
  type MessagePopup,
  type Popup,
} from '../../stores/ui';
import { useFilesBlocked } from '../chat/files-blocked';
import {
  confirmDelete,
  copyFile,
  copyMessage,
  copyToClipboard,
  fileCopyLabel,
  messageCopyLabel,
  openForward,
} from '../chat/message-actions';
import { startEditing, startReply, useChat } from '../chat/store';
import { effectiveVolume, maxVolume, mutedForMe } from '../voice/audio-route';
import { voice } from '../voice/controller';
import { DUCKING_LEVEL_MAX, DUCKING_LEVEL_MIN } from '../voice/ducking';
import { useVoice } from '../voice/store';
import { NameText, OwnerMark } from './NameText';
import styles from './profile.module.scss';

const percent = (v: number) => `${Math.round(v * 100)}%`;

function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const clamp = () => {
      const margin = 8;
      const inset =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--titlebar-inset'),
        ) || 0;
      const left = Math.max(margin, Math.min(x, window.innerWidth - node.offsetWidth - margin));
      const top = Math.max(
        margin + inset,
        Math.min(y, window.innerHeight - node.offsetHeight - margin),
      );
      setPos((now) => (now.left === left && now.top === top ? now : { left, top }));
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(node);
    return () => observer.disconnect();
  }, [x, y]);
  return { ref, pos };
}

export function Popups() {
  const popup = useUi((s) => s.popup);

  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePopup();
      }
    };
    const width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== width) closePopup();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closePopup);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closePopup);
      window.removeEventListener('resize', onResize);
    };
  }, [popup]);

  return (
    <AnimatePresence>
      {popup && (
        <motion.div
          key="scrim"
          className={styles.scrim}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closePopup();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (e.target === e.currentTarget) closePopup();
          }}
          onWheel={(e) => {
            if (popup.kind === 'message-menu' && e.target === e.currentTarget) closePopup();
          }}
          exit={{ opacity: 1 }}
          transition={{ duration: 0.12 }}
        >
          <Floating
            key={`${popup.kind}:${popup.kind === 'message-menu' ? popup.messageId : popup.userId}:${popup.x}:${popup.y}`}
            popup={popup}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Floating({ popup }: { popup: Popup }) {
  const { ref, pos } = useClampedPosition(popup.x, popup.y);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    const trigger = previousFocus.current;
    const panel = ref.current;
    panel?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (!now || now === document.body || panel?.contains(now)) {
        trigger?.focus?.({ preventScroll: true });
      }
    };
  }, [ref]);

  return (
    <motion.div
      ref={ref}
      className={popup.kind === 'profile' ? styles.cardFrame : styles.menu}
      style={{ left: pos.left, top: pos.top }}
      initial={{ opacity: 0, scale: 0.94, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -2, transition: { duration: 0.1 } }}
      transition={{ type: 'spring', stiffness: 560, damping: 34, mass: 0.7 }}
    >
      {popup.kind === 'profile' && <ProfileCard userId={popup.userId} />}
      {popup.kind === 'member-menu' && <MemberMenu popup={popup} />}
      {popup.kind === 'share-menu' && <ShareMenu popup={popup} />}
      {popup.kind === 'message-menu' && <MessageMenu popup={popup} />}
    </motion.div>
  );
}

function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('button, input, a[role="menuitem"]'),
  );
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? at + 1
          : at - 1;
  items[(next + items.length) % items.length]?.focus();
}

function glideTo(menu: HTMLElement, target: EventTarget | null) {
  const item = target instanceof Element ? target.closest('[role="menuitem"]') : null;
  if (!(item instanceof HTMLElement) || !menu.contains(item)) {
    menu.style.setProperty('--glide-opacity', '0');
    return;
  }
  const from = menu.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  menu.style.setProperty('--glide-y', `${box.top - from.top}px`);
  menu.style.setProperty('--glide-h', `${box.height}px`);
  menu.style.setProperty('--glide-opacity', '1');
}

const glideHandlers = {
  onPointerOver: (e: ReactPointerEvent<HTMLDivElement>) => glideTo(e.currentTarget, e.target),
  onPointerLeave: (e: ReactPointerEvent<HTMLDivElement>) => glideTo(e.currentTarget, null),
  onFocus: (e: ReactFocusEvent<HTMLDivElement>) => {
    if (e.target.matches(':focus-visible')) glideTo(e.currentTarget, e.target);
  },
};

function MenuItem({
  icon,
  children,
  onClick,
  tone,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(styles.menuItem, tone === 'danger' && styles.menuItemDanger)}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function MenuSlider({
  label,
  value,
  min = 0,
  max = 2,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <div className={styles.menuSlider} data-testid={testId}>
      <div className={styles.menuSliderHead}>
        <span>{label}</span>
        <span className={styles.menuValue}>{percent(value)}</span>
      </div>
      <Slider
        label={label}
        min={min}
        max={max}
        value={value}
        onChange={onChange}
        format={percent}
      />
    </div>
  );
}

function useMember(userId: string): UserPublic | undefined {
  const member = useCommunity((s) => s.members[userId]);
  const self = useSession((s) => s.user);
  return self?.id === userId ? self : member;
}

function PersonVolume({ userId, name }: { userId: string; name: string }) {
  const volume = useVoice((s) => s.volumes[userId] ?? 1);
  const muted = useVoice((s) => mutedForMe(!!s.localMutes[userId], s.volumes[userId]));
  return (
    <>
      {maxVolume() > 0 && (
        <MenuSlider
          label="User volume"
          value={effectiveVolume(volume)}
          max={maxVolume()}
          onChange={(v) => voice().setParticipantVolume(userId, v)}
          testId="user-volume"
        />
      )}
      <MenuItem
        icon={muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        onClick={() => voice().setLocalMute(userId, !muted)}
      >
        {muted ? `Unmute ${name} for me` : `Mute ${name} for me`}
      </MenuItem>
    </>
  );
}

function MemberMenu({ popup }: { popup: MemberPopup }) {
  const { userId } = popup;
  const member = useMember(userId);
  const selfId = useSession((s) => s.user?.id);
  const role = useSession((s) => s.user?.role);
  const hasStream = useVoice((s) => !!s.remotes[userId]?.screenShareAudio);
  const streamVolume = useVoice((s) => s.streamVolumes[userId] ?? 1);
  const isSelf = userId === selfId;
  const name = member?.displayName ?? 'this member';
  return (
    <div
      role="menu"
      aria-label={`Actions for ${name}`}
      data-testid="member-menu"
      className={styles.glide}
      onKeyDown={onMenuKeyDown}
      {...glideHandlers}
    >
      <div className={styles.menuHeader}>
        <Avatar
          name={name}
          color={member?.avatarColor ?? '#525252'}
          src={member?.avatarUrl}
          size={28}
          animate
        />
        <div className={styles.menuHeaderText}>
          <NameText user={member} live />
        </div>
      </div>
      <MenuItem
        icon={<UserRound size={15} />}
        onClick={() => openPopup({ ...popup, kind: 'profile' })}
      >
        View profile
      </MenuItem>
      {isSelf && (
        <MenuItem
          icon={<Pencil size={15} />}
          onClick={() => {
            closePopup();
            useUi.setState({ settingsTab: 'profile' });
          }}
        >
          Edit profile
        </MenuItem>
      )}
      {!isSelf && (
        <>
          <div className={styles.menuSeparator} />
          <PersonVolume userId={userId} name={name} />
          {hasStream && maxVolume() > 0 && (
            <MenuSlider
              label="Stream volume"
              value={effectiveVolume(streamVolume)}
              max={maxVolume()}
              onChange={(v) => voice().setStreamVolume(userId, v)}
            />
          )}
        </>
      )}
      {!isSelf && role === 'owner' && (
        <>
          <div className={styles.menuSeparator} />
          <MenuItem
            icon={<ShieldCheck size={15} />}
            onClick={() => {
              closePopup();
              useUi.setState({ settingsTab: 'members' });
            }}
          >
            Manage members
          </MenuItem>
        </>
      )}
    </div>
  );
}

function MessageMenu({ popup }: { popup: MessagePopup }) {
  const message = useChat((s) =>
    s.windows[popup.channelId]?.messages.find((m) => m.id === popup.messageId),
  );
  const selfId = useSession((s) => s.user?.id);
  const role = useSession((s) => s.user?.role);
  const filesBlocked = useFilesBlocked();
  const gone = !message;
  useEffect(() => {
    if (gone) closePopup();
  }, [gone]);
  if (!message) return null;

  const file = filesBlocked
    ? undefined
    : (message.attachments.find((a) => a.id === popup.attachmentId) ??
      (!message.content && message.attachments.length === 1 ? message.attachments[0] : undefined));
  const isOwn = message.authorId === selfId;
  const canEdit = isOwn && !message.forwardedFrom;
  const canDelete = isOwn || role === 'owner';
  const copyable = popup.selection || message.content;
  const copyAll = !copyable && !file ? messageCopyLabel(message, filesBlocked) : null;

  return (
    <div
      role="menu"
      aria-label="Message actions"
      data-testid="message-menu"
      className={cx(styles.glide, styles.messageMenu)}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          closePopup();
          return;
        }
        onMenuKeyDown(e);
      }}
      {...glideHandlers}
    >
      <MenuItem
        icon={<Reply size={15} />}
        onClick={() => {
          closePopup();
          startReply(message);
        }}
      >
        Reply
      </MenuItem>
      <MenuItem
        icon={<Forward size={15} />}
        onClick={() => {
          closePopup();
          openForward(message);
        }}
      >
        Forward
      </MenuItem>
      {copyable && (
        <MenuItem
          icon={<Copy size={15} />}
          onClick={() => {
            closePopup();
            void (popup.selection
              ? copyToClipboard(popup.selection, 'Selection copied.')
              : copyToClipboard(message.content, 'Text copied.'));
          }}
        >
          {popup.selection ? 'Copy selection' : 'Copy text'}
        </MenuItem>
      )}
      {file && (
        <MenuItem
          icon={<Copy size={15} />}
          onClick={() => {
            closePopup();
            void copyFile(file);
          }}
        >
          {fileCopyLabel(file)}
        </MenuItem>
      )}
      {file && (
        <a
          role="menuitem"
          className={styles.menuItem}
          href={mediaUrl(file.url)}
          download={file.fileName}
          onClick={closePopup}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
        >
          <Download size={15} />
          <span>{file.kind === 'video' ? 'Save video' : 'Save image'}</span>
        </a>
      )}
      {copyAll && (
        <MenuItem
          icon={<Copy size={15} />}
          onClick={() => {
            closePopup();
            void copyMessage(message);
          }}
        >
          {copyAll}
        </MenuItem>
      )}
      {(canEdit || canDelete) && <div className={styles.menuSeparator} />}
      {canEdit && (
        <MenuItem
          icon={<Pencil size={15} />}
          onClick={() => {
            closePopup();
            startEditing(message.channelId, message.id);
          }}
        >
          Edit
        </MenuItem>
      )}
      {canDelete && (
        <MenuItem
          icon={<Trash2 size={15} />}
          tone="danger"
          onClick={() => {
            closePopup();
            confirmDelete(message);
          }}
        >
          Delete
        </MenuItem>
      )}
    </div>
  );
}

function ShareMenu({ popup }: { popup: MemberPopup }) {
  const { userId } = popup;
  const selfId = useSession((s) => s.user?.id);
  const isLocal = userId === selfId;
  const member = useMember(userId);
  const streamVolume = useVoice((s) => s.streamVolumes[userId] ?? 1);
  const hasAudio = useVoice((s) => !!s.remotes[userId]?.screenShareAudio);
  const ducking = useVoice((s) => s.streamDucking);
  const duckingLevel = useVoice((s) => s.duckingLevel);
  const focused = useUi((s) => s.focusedShare === userId);
  return (
    <div
      role="menu"
      aria-label="Stream actions"
      data-testid="share-menu"
      className={styles.glide}
      onKeyDown={onMenuKeyDown}
      {...glideHandlers}
    >
      <div className={styles.menuTitle}>
        {isLocal ? 'Your screen' : `${member?.displayName ?? 'Someone'}’s stream`}
      </div>
      {!isLocal && hasAudio && maxVolume() > 0 && (
        <MenuSlider
          label="Stream volume"
          value={effectiveVolume(streamVolume)}
          max={maxVolume()}
          onChange={(v) => voice().setStreamVolume(userId, v)}
        />
      )}
      {!isLocal && maxVolume() > 0 && (
        <div className={styles.menuSwitch}>
          <Switch
            checked={ducking}
            onChange={(value) => useVoice.setState({ streamDucking: value })}
            label="Lower streams when others talk"
            testId="share-menu-ducking"
          />
          {ducking && (
            <MenuSlider
              label="Lower to"
              value={duckingLevel}
              min={DUCKING_LEVEL_MIN}
              max={DUCKING_LEVEL_MAX}
              onChange={(v) => useVoice.setState({ duckingLevel: v })}
            />
          )}
        </div>
      )}
      {!isLocal && maxVolume() > 0 && <div className={styles.menuSeparator} />}
      <MenuItem
        icon={focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        onClick={() => {
          useUi.setState({ focusedShare: focused ? null : userId, popup: null });
        }}
      >
        {focused ? 'Show all streams' : 'Enlarge this stream'}
      </MenuItem>
      {!isLocal && member && (
        <MenuItem
          icon={<UserRound size={15} />}
          onClick={() => openPopup({ ...popup, kind: 'profile' })}
        >
          View profile
        </MenuItem>
      )}
      {isLocal && (
        <MenuItem
          icon={<MonitorOff size={15} />}
          tone="danger"
          onClick={() => {
            closePopup();
            void voice().stopScreenShare();
          }}
        >
          Stop sharing
        </MenuItem>
      )}
    </div>
  );
}

function trackSpotlight(e: ReactPointerEvent<HTMLElement>) {
  const box = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--spot-x', `${e.clientX - box.left}px`);
  e.currentTarget.style.setProperty('--spot-y', `${e.clientY - box.top}px`);
}

export function ProfileBanner({
  user,
}: {
  user: Pick<UserPublic, 'bannerUrl' | 'bannerColor' | 'avatarColor'> | undefined;
}) {
  const color = user?.bannerColor ?? user?.avatarColor ?? '#2e2e2e';
  const filesBlocked = useFilesBlocked();
  return (
    <div
      className={styles.banner}
      style={{
        background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #0a0a0a))`,
      }}
    >
      {user?.bannerUrl && (
        <img
          key={String(filesBlocked)}
          src={mediaUrl(user.bannerUrl)}
          alt=""
          draggable={false}
          className={styles.bannerImg}
        />
      )}
    </div>
  );
}

export function StatusChip({ online, status }: { online: boolean; status: string | null }) {
  const text = online ? status || 'Online' : 'Offline';
  return (
    <span className={styles.chip} title={text} data-testid="status-chip">
      <span className={styles.chipStatus}>{text}</span>
    </span>
  );
}

function ProfileCard({ userId }: { userId: string }) {
  const member = useMember(userId);
  const selfId = useSession((s) => s.user?.id);
  const online = useCommunity((s) => !!s.online[userId]);
  const rooms = useCommunity((s) => s.voice.rooms);
  const channels = useCommunity((s) => s.channels);
  const speaking = useVoice((s) => !!s.speaking[userId]);
  const isSelf = userId === selfId;
  const name = member?.displayName ?? 'Unknown member';
  const room = Object.entries(rooms).find(([, list]) =>
    (list ?? NO_PARTICIPANTS).some((p) => p.userId === userId),
  );
  const roomName = room ? channels.find((c) => c.id === room[0])?.name : null;
  return (
    <article
      className={styles.card}
      data-testid="profile-card"
      aria-label={`Profile of ${name}`}
      onPointerMove={trackSpotlight}
    >
      <ProfileBanner user={member} />
      <div className={styles.cardHead}>
        <div className={styles.cardAvatar}>
          <Avatar
            name={name}
            color={member?.avatarColor ?? '#525252'}
            src={member?.avatarUrl}
            size={76}
            online={online}
            speaking={speaking}
            animate
          />
        </div>
        <div className={styles.cardIdentity}>
          <div className={styles.cardNameRow}>
            <div className={styles.cardName} title={name}>
              <NameText user={member} live />
            </div>
            {member?.role === 'owner' && <OwnerMark />}
          </div>
          <div className={styles.cardMeta}>
            {member?.disabled && <span className={styles.chip}>Removed</span>}
            <StatusChip online={online} status={member?.customStatus ?? null} />
            {roomName && (
              <span className={cx(styles.chip, styles.chipVoice)} title={roomName}>
                <AudioLines size={12} aria-hidden />
                <span className={styles.chipText}>{roomName}</span>
              </span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.cardBody}>
        {isSelf ? (
          <Button
            wide
            small
            onClick={() => {
              closePopup();
              useUi.setState({ settingsTab: 'profile' });
            }}
          >
            <Pencil size={14} /> Edit profile
          </Button>
        ) : (
          <div className={styles.cardControls} role="group" aria-label={`Volume for ${name}`}>
            <PersonVolume userId={userId} name={name} />
          </div>
        )}
      </div>
    </article>
  );
}
