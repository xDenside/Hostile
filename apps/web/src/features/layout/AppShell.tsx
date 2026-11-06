import { JoinRequestCard } from '../join/JoinRequests';
import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { useTunnel } from '../../tunnel/state';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  Hash,
  Headphones,
  HeadphoneOff,
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  Settings,
  Users,
  Volume2,
} from 'lucide-react';
import { BRAND, type ChannelDTO } from '@hostile/shared';
import { changeRoomCode } from '../../app/session';
import { Avatar, Banner, Button, EmptyState, IconButton, Logo } from '../../components/ui';
import { useIsPhone } from '../../lib/use-media-query';
import { isUnread, NO_PARTICIPANTS, useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { selectChannel, useUi } from '../../stores/ui';
import { ChannelView } from '../chat/ChannelView';
import { DeleteDialog } from '../chat/DeleteDialog';
import { ForwardDialog } from '../chat/ForwardDialog';
import { useChat } from '../chat/store';
import { CallView } from '../voice/CallView';
import { ScreenSharePicker } from '../voice/ScreenSharePicker';
import { voice } from '../voice/controller';
import { connectionSignal } from '../voice/connection-signal';
import { isMicError, useVoice } from '../voice/store';
import { NameText } from '../profile/NameText';
import { SidebarResizer } from './SidebarResizer';
import { Popups } from '../profile/Popups';
import { memberTrigger } from '../profile/triggers';
import { SettingsPage } from '../settings/SettingsPage';
import { useShortcuts } from '../shortcuts/useShortcuts';
import { useVoiceChat } from '../voice/useVoiceChat';
import {
  micIndicator,
  ownRoomParticipants,
  presenceDoubt,
  PRESENCE_DOUBT_LABEL,
  VOICE_NOTICE_WORDS,
  voiceServerNotice,
  withLiveMic,
  type VoiceServerNotice,
} from './status';
import styles from './layout.module.scss';

export function AppShell() {
  const self = useSession((s) => s.user!);
  const channels = useCommunity((s) => s.channels);
  const ready = useCommunity((s) => s.ready);
  const selectedId = useUi((s) => s.selectedChannelId);
  const settingsTab = useUi((s) => s.settingsTab);
  const pickerOpen = useUi((s) => s.screenPickerOpen);
  const forwarding = useChat((s) => s.forwarding !== null);
  const deletingId = useChat((s) => s.deleting?.id);

  const selected = useMemo(
    () =>
      channels.find((c) => c.id === selectedId) ?? channels.find((c) => c.type === 'text') ?? null,
    [channels, selectedId],
  );

  useEffect(() => {
    if (selected && selected.id !== selectedId) selectChannel(selected.id, self.id);
  }, [selected, selectedId, self.id]);

  useShortcuts();

  return (
    <div className={styles.shell}>
      <Sidebar channels={channels} selectedId={selected?.id ?? null} />
      <MainColumn channel={selected} ready={ready} />
      {selected?.type !== 'voice' && <MemberPanel />}
      <AnimatePresence>
        {settingsTab && <SettingsPage key="settings" />}
        {pickerOpen && <ScreenSharePicker key="picker" />}
        {forwarding && <ForwardDialog key="forward" />}
        {deletingId && <DeleteDialog key={`delete-${deletingId}`} />}
      </AnimatePresence>
      <Popups />
      <JoinRequestCard />
    </div>
  );
}

function Sidebar({ channels, selectedId }: { channels: ChannelDTO[]; selectedId: string | null }) {
  const self = useSession((s) => s.user!);
  const communityName = useCommunity((s) => s.communityName);
  const readStates = useCommunity((s) => s.readStates);
  const text = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const phone = useIsPhone();
  const navOpen = useUi((s) => s.navOpen);

  useEffect(() => {
    if (!phone || !navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useUi.setState({ navOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, navOpen]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const from = touchStart.current;
    const touch = e.changedTouches[0];
    if (!from || !touch) return;
    const dx = touch.clientX - from.x;
    if (dx < -60 && Math.abs(dx) > Math.abs(touch.clientY - from.y)) {
      useUi.setState({ navOpen: false });
    }
  };

  return (
    <>
      <AnimatePresence>
        {phone && navOpen && (
          <motion.div
            className={styles.navScrim}
            data-testid="nav-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => useUi.setState({ navOpen: false })}
          />
        )}
      </AnimatePresence>
      <nav
        className={[styles.sidebar, navOpen ? styles.sidebarOpen : ''].join(' ')}
        aria-label="Channels"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className={styles.sidebarHeader}>
          <Logo size={15} />
          <h1 title={communityName}>{communityName || BRAND.displayName}</h1>
          <div className={styles.headerActions}>
            {self.role === 'owner' && (
              <IconButton
                label="Manage channels"
                icon={<Plus size={17} />}
                tipBelow
                onClick={() => useUi.setState({ settingsTab: 'channels' })}
              />
            )}
          </div>
        </div>

        <LayoutGroup id="channels">
          <motion.div layoutScroll className={styles.channelScroll}>
            <div className={styles.sectionHead}>Text channels</div>
            {text.length === 0 && <div className={styles.joinVoiceHint}>No text channels yet.</div>}
            {text.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={[
                  styles.channel,
                  channel.id === selectedId ? styles.channelSelected : '',
                  isUnread(channel, readStates) ? styles.channelUnread : '',
                ].join(' ')}
                aria-current={channel.id === selectedId ? 'page' : undefined}
                onClick={() => selectChannel(channel.id, self.id)}
              >
                {channel.id === selectedId && <SelectedPill />}
                <Hash size={16} className={styles.channelIcon} />
                <span className={styles.channelName}>{channel.name}</span>
                {isUnread(channel, readStates) && (
                  <span className={styles.unreadDot} aria-label="Unread messages" />
                )}
              </button>
            ))}

            <div className={styles.sectionHead}>Voice channels</div>
            {voiceChannels.length === 0 && (
              <div className={styles.joinVoiceHint}>No voice channels yet.</div>
            )}
            {voiceChannels.map((channel) => (
              <VoiceChannelItem
                key={channel.id}
                channel={channel}
                selected={channel.id === selectedId}
              />
            ))}
          </motion.div>
        </LayoutGroup>

        <Dock />
        {!phone && <SidebarResizer />}
      </nav>
    </>
  );
}

function SelectedPill() {
  return (
    <motion.span
      layoutId="selected-channel"
      className={styles.selectedPill}
      style={{ borderRadius: 5 }}
      transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
    />
  );
}

function VoiceChannelItem({ channel, selected }: { channel: ChannelDTO; selected: boolean }) {
  const self = useSession((s) => s.user!);
  const members = useCommunity((s) => s.members);
  const readStates = useCommunity((s) => s.readStates);
  const snapshot = useCommunity((s) => s.voice.rooms[channel.id] ?? NO_PARTICIPANTS);
  const mediaReachable = useCommunity((s) => s.voice.mediaReachable);
  const mediaCheckedAt = useCommunity((s) => s.voice.checkedAt);
  const roomsConfirmedAt = useCommunity((s) => s.voice.roomsConfirmedAt);
  const ready = useCommunity((s) => s.ready);
  const status = useVoice((s) => s.status);
  const activeChannel = useVoice((s) => s.channelId);
  const speaking = useVoice((s) => s.speaking);
  const inThisChannel = activeChannel === channel.id && status !== 'idle';
  const voiceNotice = voiceServerNotice(ready, { mediaReachable, checkedAt: mediaCheckedAt });
  const remotes = useVoice((s) => s.remotes);
  const selfMuted = useVoice((s) => s.micMuted || s.deafened);
  const selfDeafened = useVoice((s) => s.deafened);
  const apiDoubt = presenceDoubt(ready, {
    mediaReachable,
    checkedAt: mediaCheckedAt,
    roomsConfirmedAt,
  });
  const ownRoom = inThisChannel && status === 'connected';
  const doubt = ownRoom ? null : apiDoubt;
  const micPublished = useVoice((s) => s.micPublished);
  const me = { userId: self.id, muted: selfMuted, deafened: selfDeafened, micPublished };
  const participants = ownRoom
    ? ownRoomParticipants(snapshot, apiDoubt, me, remotes).map((p) => withLiveMic(p, me, remotes))
    : snapshot;

  return (
    <>
      <button
        type="button"
        className={[styles.channel, selected ? styles.channelSelected : ''].join(' ')}
        onPointerEnter={() => voice().preload()}
        onClick={() => {
          selectChannel(channel.id, self.id);
          if (!inThisChannel) void voice().join(channel.id);
        }}
        title={voiceNotice ? VOICE_NOTICE_WORDS[voiceNotice] : undefined}
      >
        {selected && <SelectedPill />}
        <Volume2 size={16} className={styles.channelIcon} />
        <span className={styles.channelName}>{channel.name}</span>
        {participants.length > 0 && !doubt && (
          <span className={styles.channelIcon}>{participants.length}</span>
        )}
        {isUnread(channel, readStates) && (
          <span className={styles.unreadDot} aria-label="Unread messages" />
        )}
      </button>
      {participants.length > 0 && (
        <ul
          className={[styles.voiceParticipants, doubt ? styles.voiceParticipantsStale : ''].join(
            ' ',
          )}
          title={doubt ? PRESENCE_DOUBT_LABEL[doubt] : undefined}
          aria-label={doubt ? PRESENCE_DOUBT_LABEL[doubt] : undefined}
        >
          {participants.map((p) => {
            const member = members[p.userId];
            const name = member?.displayName ?? 'Unknown';
            const mic = micIndicator(p);
            return (
              <li key={p.userId}>
                <button
                  type="button"
                  className={styles.voiceParticipant}
                  {...memberTrigger(p.userId)}
                >
                  <Avatar
                    name={name}
                    color={member?.avatarColor ?? '#525252'}
                    src={member?.avatarUrl}
                    size={20}
                    speaking={!!speaking[p.userId]}
                  />
                  <span className={styles.participantName}>
                    <NameText user={member ?? { displayName: name }} live />
                  </span>
                  {!doubt && (
                    <span className={styles.participantIcons}>
                      {p.screenSharing && <span className={styles.sharing}>LIVE</span>}
                      {p.selfDeafened ? (
                        <HeadphoneOff size={13} className={styles.muted} aria-label="Deafened" />
                      ) : mic === 'muted' ? (
                        <MicOff size={13} className={styles.muted} aria-label="Muted" />
                      ) : mic === 'no-microphone' ? (
                        <MicOff size={13} className={styles.noMic} aria-label="No microphone" />
                      ) : null}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function MicButton({ className }: { className?: string }) {
  const off = useVoice((s) => s.micMuted || s.deafened);
  return (
    <IconButton
      label={off ? 'Unmute microphone' : 'Mute microphone'}
      icon={off ? <MicOff size={17} /> : <Mic size={17} />}
      tone={off ? 'active' : 'default'}
      pressed={off}
      className={className}
      onClick={() => voice().toggleMute()}
    />
  );
}

function DeafenButton({ className }: { className?: string }) {
  const deafened = useVoice((s) => s.deafened);
  return (
    <IconButton
      label={deafened ? 'Undeafen' : 'Deafen (stop hearing everyone)'}
      icon={deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
      tone={deafened ? 'active' : 'default'}
      pressed={deafened}
      className={className}
      onClick={() => voice().toggleDeafen()}
    />
  );
}

function ShareButton({ className }: { className?: string }) {
  const localShare = useVoice((s) => s.localShare);
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  return (
    <IconButton
      label={localShare ? 'Stop sharing your screen' : 'Share your screen'}
      icon={<MonitorUp size={17} />}
      tone={localShare ? 'active' : 'default'}
      pressed={!!localShare}
      className={className}
      onClick={() =>
        localShare ? void voice().stopScreenShare() : useUi.setState({ screenPickerOpen: true })
      }
    />
  );
}

function LeaveButton({ className }: { className?: string }) {
  return (
    <IconButton
      label="Leave voice"
      tone="danger"
      icon={<PhoneOff size={17} />}
      className={className}
      onClick={() => void voice().leave()}
    />
  );
}

function CallTitle() {
  const status = useVoice((s) => s.status);
  const channelId = useVoice((s) => s.channelId);
  const quality = useVoice((s) => s.connectionQuality);
  const signal = connectionSignal(status, quality);
  const channels = useCommunity((s) => s.channels);
  const name = channels.find((c) => c.id === channelId)?.name ?? 'Voice';
  const stateText =
    status === 'connected'
      ? 'Voice connected'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'requesting-token'
          ? 'Authorizing…'
          : 'Connecting…';
  return (
    <div className={styles.callTitle} title={name}>
      <span
        className={styles.signal}
        data-testid="connection-signal"
        data-quality={quality}
        data-bars={signal.bars}
        data-seeking={signal.seeking || undefined}
        data-lost={signal.lost || undefined}
        role="img"
        aria-label={signal.label}
        title={signal.label}
      >
        <i />
        <i />
        <i />
      </span>
      <span className={styles.callName}>{status === 'connected' ? name : stateText}</span>
      <span className={styles.callStateSpoken} data-testid="voice-state">
        {stateText}
      </span>
    </div>
  );
}

function MicProblem() {
  const error = useVoice((s) => s.error);
  if (!error || !isMicError(error)) return null;
  return (
    <div className={styles.callProblem}>
      <Banner kind="warning">
        {error.message}{' '}
        <button className={styles.retryLink} onClick={() => void voice().retryMicrophone()}>
          Try again
        </button>
      </Banner>
    </div>
  );
}

function Dock() {
  const phone = useIsPhone();
  const inCall = useVoice((s) => s.status !== 'idle');
  return (
    <div className={styles.dock} data-testid="dock">
      {inCall && !phone && (
        <div className={styles.dockCall}>
          <div className={styles.dockCallRow}>
            <CallTitle />
            <div className={styles.voiceButtons}>
              <ShareButton />
              <LeaveButton />
            </div>
          </div>
          <MicProblem />
        </div>
      )}
      <UserPanel />
    </div>
  );
}

function PhoneCallPanel() {
  const inCall = useVoice((s) => s.status !== 'idle');
  if (!inCall) return null;
  return (
    <div className={styles.phoneCall}>
      <CallTitle />
      <MicProblem />
      <div className={styles.phoneCallButtons}>
        <MicButton className={styles.callTile} />
        <DeafenButton className={styles.callTile} />
        <ShareButton className={styles.callTile} />
        <LeaveButton className={[styles.callTile, styles.callTileDanger].join(' ')} />
      </div>
    </div>
  );
}

function UserPanel() {
  const self = useSession((s) => s.user!);
  const online = useCommunity((s) => !!s.online[self.id]);
  return (
    <div className={styles.userPanel} data-testid="own-card">
      <button type="button" className={styles.userButton} {...memberTrigger(self.id)}>
        <Avatar
          name={self.displayName}
          color={self.avatarColor}
          src={self.avatarUrl}
          size={36}
          online={online}
          animate
        />
        <div className={styles.userInfo}>
          <div className={styles.userName}>
            <NameText user={self} live />
          </div>
        </div>
      </button>
      <div className={styles.voiceButtons}>
        <MicButton />
        <DeafenButton />
        <IconButton
          label="Settings"
          icon={<Settings size={17} />}
          onClick={() => useUi.setState({ settingsTab: 'profile' })}
        />
      </div>
    </div>
  );
}

function MainColumn({ channel, ready }: { channel: ChannelDTO | null; ready: boolean }) {
  const connection = useCommunity((s) => s.connection);
  const hostAway = useTunnel((s) => s.phase === 'away');
  const connectionError = useCommunity((s) => s.connectionError);
  const mediaReachable = useCommunity((s) => s.voice.mediaReachable);
  const mediaCheckedAt = useCommunity((s) => s.voice.checkedAt);
  const voiceError = useVoice((s) => s.error);
  const audioBlocked = useVoice((s) => s.audioPlaybackBlocked);
  const memberListOpen = useUi((s) => s.memberListOpen);
  const voiceChat = useVoiceChat();
  const phone = useIsPhone();
  const readStates = useCommunity((s) => s.readStates);
  const channels = useCommunity((s) => s.channels);
  const showCall = channel?.type === 'voice';
  const voiceNotice = voiceServerNotice(ready, { mediaReachable, checkedAt: mediaCheckedAt });
  const lastingVoiceNotice = useLastingNotice(voiceNotice);
  const showVoiceError = voiceError && !isMicError(voiceError);

  return (
    <main className={styles.main}>
      <header className={styles.mainHeader}>
        {phone && (
          <IconButton
            label="Open channel list"
            icon={
              <>
                <Menu size={20} />
                {channels.some((c) => isUnread(c, readStates)) && (
                  <span className={styles.toggleDot} data-testid="nav-unread" aria-hidden />
                )}
              </>
            }
            tipBelow
            data-testid="nav-toggle"
            onClick={() => useUi.setState({ navOpen: true })}
          />
        )}
        <div className={styles.mainHeaderTitle}>
          {channel ? (
            <>
              {channel.type === 'text' ? (
                <Hash size={18} className={styles.channelIcon} />
              ) : (
                <Volume2 size={18} className={styles.channelIcon} />
              )}
              <span>{channel.name}</span>
            </>
          ) : (
            <span>{BRAND.displayName}</span>
          )}
        </div>
        <div className={styles.mainHeaderActions}>
          <ConnectionBadge state={connection} />
          {showCall ? (
            <IconButton
              label={voiceChat.open ? 'Hide chat' : 'Show chat'}
              icon={
                <>
                  <MessageSquare size={17} />
                  {!voiceChat.open && channel && isUnread(channel, readStates) && (
                    <span className={styles.toggleDot} aria-hidden />
                  )}
                </>
              }
              pressed={voiceChat.open}
              tipBelow
              data-testid="voice-chat-toggle"
              onClick={() => voiceChat.setOpen(!voiceChat.open)}
            />
          ) : (
            <IconButton
              label={memberListOpen ? 'Hide members' : 'Show members'}
              icon={<Users size={17} />}
              pressed={memberListOpen}
              tipBelow
              className={styles.membersToggle}
              onClick={() => useUi.setState({ memberListOpen: !memberListOpen })}
            />
          )}
        </div>
      </header>

      {(connection === 'reconnecting' ||
        connectionError ||
        showVoiceError ||
        audioBlocked ||
        lastingVoiceNotice) && (
        <div className={styles.banners}>
          {connection === 'reconnecting' && (
            <Banner kind="warning">
              {hostAway ? (
                <>
                  The host is away. This reconnects by itself when they come back. If this goes on,
                  ask them whether the code changed.{' '}
                  <Button small onClick={() => void changeRoomCode()}>
                    Use a different code
                  </Button>
                </>
              ) : (
                'Reconnecting to the server… messages will sync automatically.'
              )}
            </Banner>
          )}
          {connectionError && <Banner kind="error">{connectionError}</Banner>}
          {audioBlocked && (
            <Banner kind="warning">
              Your browser blocked audio playback.{' '}
              <Button small onClick={() => void voice().resumeAudio()}>
                Enable audio
              </Button>
            </Banner>
          )}
          {voiceError && showVoiceError && (
            <Banner kind={voiceError.kind === 'duplicate' ? 'info' : 'error'}>
              {voiceError.message}
            </Banner>
          )}
          {lastingVoiceNotice && (
            <Banner kind="warning">{VOICE_NOTICE_WORDS[lastingVoiceNotice]}</Banner>
          )}
        </div>
      )}

      <div className={styles.content}>
        {!ready ? (
          <EmptyState title="Loading your community…" />
        ) : !channel ? (
          <EmptyState title="No channels yet">
            {useSession.getState().user?.role === 'owner'
              ? 'Create the first channel from Settings → Channels.'
              : 'Ask the owner to create a channel.'}
          </EmptyState>
        ) : showCall ? (
          <CallView channel={channel} />
        ) : (
          <ChannelView channel={channel} />
        )}
      </div>
      {phone && <PhoneCallPanel />}
    </main>
  );
}

const VOICE_NOTICE_HELD_MS = 20_000;

function useLastingNotice(notice: VoiceServerNotice) {
  const [lasting, setLasting] = useState<VoiceServerNotice>(null);
  useEffect(() => {
    const timer = setTimeout(() => setLasting(notice), notice ? VOICE_NOTICE_HELD_MS : 0);
    return () => clearTimeout(timer);
  }, [notice]);
  return notice === lasting ? notice : null;
}

function ConnectionBadge({
  state,
}: {
  state: 'connecting' | 'connected' | 'reconnecting' | 'offline';
}) {
  const hostAway = useTunnel((s) => s.phase === 'away');
  const label = hostAway
    ? 'Host away'
    : state === 'connected'
      ? 'Connected'
      : state === 'connecting'
        ? 'Connecting'
        : state === 'reconnecting'
          ? 'Reconnecting'
          : 'Offline';
  const dotClass =
    state === 'connected'
      ? styles.connDot
      : state === 'offline'
        ? `${styles.connDot} ${styles.connDotBad}`
        : `${styles.connDot} ${styles.connDotWarn}`;
  return (
    <span className={styles.connBadge} data-testid="connection-state" data-state={state}>
      <span className={dotClass} aria-hidden />
      {label}
    </span>
  );
}

function MemberPanel() {
  const open = useUi((s) => s.memberListOpen);
  const members = useCommunity((s) => s.members);
  const online = useCommunity((s) => s.online);
  if (!open) return null;
  const list = Object.values(members).filter((m) => !m.disabled);
  const onlineMembers = list.filter((m) => online[m.id]);
  const offlineMembers = list.filter((m) => !online[m.id]);

  return (
    <aside className={styles.members} aria-label="Members">
      <div className={styles.sectionHead}>Online — {onlineMembers.length}</div>
      {onlineMembers.map((m) => (
        <button key={m.id} type="button" className={styles.memberRow} {...memberTrigger(m.id)}>
          <Avatar name={m.displayName} color={m.avatarColor} src={m.avatarUrl} size={24} online />
          <span className={styles.memberName}>
            <NameText user={m} live />
          </span>
        </button>
      ))}
      {offlineMembers.length > 0 && (
        <div className={styles.sectionHead}>Offline — {offlineMembers.length}</div>
      )}
      {offlineMembers.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`${styles.memberRow} ${styles.memberOffline}`}
          {...memberTrigger(m.id)}
        >
          <Avatar
            name={m.displayName}
            color={m.avatarColor}
            src={m.avatarUrl}
            size={24}
            online={false}
          />
          <span className={styles.memberName}>
            <NameText user={m} live />
          </span>
        </button>
      ))}
    </aside>
  );
}
