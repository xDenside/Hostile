import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, MicOff, Minimize2, PhoneOff, Volume2, VolumeX, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ChannelDTO, UserPublic } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { Avatar, Button, cx, EmptyState, IconButton, Slider, Spinner } from '../../components/ui';
import { stillFrame } from '../../lib/still-frame';
import { NO_PARTICIPANTS, useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { openPopup, useUi } from '../../stores/ui';
import { ChannelView } from '../chat/ChannelView';
import { useFilesBlocked } from '../chat/files-blocked';
import { NameText } from '../profile/NameText';
import { memberTrigger } from '../profile/triggers';
import {
  micIndicator,
  ownRoomParticipants,
  presenceDoubt,
  presenceSentence,
  withLiveMic,
  type MicIndicator,
} from '../layout/status';
import { effectiveVolume, maxVolume, mutedForMe } from './audio-route';
import { voice } from './controller';
import { enterVideoFullscreen } from './fullscreen';
import { fitGallery, largeAvatarSize, type TagBox } from './gallery';
import { useVoice } from './store';
import { useVoiceChat } from './useVoiceChat';
import styles from './voice.module.scss';

const GALLERY_GAP = 12;

const beamShown = new Set<string>();

function useTrackVersion(): void {
  const [, setVersion] = useState(0);
  useEffect(() => voice().onTracksChanged(() => setVersion((v) => v + 1)), []);
}

export function CallView({ channel }: { channel: ChannelDTO }) {
  const chat = useVoiceChat();
  return (
    <div className={styles.voiceLayout}>
      <div className={styles.voiceMain}>
        <CallArea channel={channel} />
      </div>
      {chat.open && (
        <aside className={styles.voiceChat} aria-label={`Chat in ${channel.name}`}>
          <div className={styles.voiceChatHead}>
            <span>Chat</span>
            <IconButton
              label="Hide chat"
              icon={<X size={15} />}
              tipBelow
              onClick={() => chat.setOpen(false)}
            />
          </div>
          <ChannelView channel={channel} />
        </aside>
      )}
    </div>
  );
}

function CallArea({ channel }: { channel: ChannelDTO }) {
  const status = useVoice((s) => s.status);
  const activeChannel = useVoice((s) => s.channelId);
  const participants = useCommunity((s) => s.voice.rooms[channel.id] ?? NO_PARTICIPANTS);
  const members = useCommunity((s) => s.members);
  const ready = useCommunity((s) => s.ready);
  const mediaReachable = useCommunity((s) => s.voice.mediaReachable);
  const checkedAt = useCommunity((s) => s.voice.checkedAt);
  const roomsConfirmedAt = useCommunity((s) => s.voice.roomsConfirmedAt);
  const inThis = activeChannel === channel.id && status !== 'idle';

  if (!inThis) {
    const doubt = presenceDoubt(ready, { mediaReachable, checkedAt, roomsConfirmedAt });
    return (
      <div className={styles.notInCall}>
        <EmptyState title={`${channel.name}`}>
          {presenceSentence(
            participants.map((p) => members[p.userId]?.displayName ?? 'Someone'),
            doubt,
          )}
        </EmptyState>
        <Button
          variant="primary"
          onClick={() => void voice().join(channel.id)}
          busy={status === 'connecting'}
        >
          Join {channel.name}
        </Button>
        {activeChannel && activeChannel !== channel.id && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
            You are currently connected to another voice channel; joining moves you here.
          </span>
        )}
      </div>
    );
  }

  return <ActiveCall channel={channel} />;
}

function ActiveCall({ channel }: { channel: ChannelDTO }) {
  const self = useSession((s) => s.user!);
  const members = useCommunity((s) => s.members);
  const snapshot = useCommunity((s) => s.voice.rooms[channel.id] ?? NO_PARTICIPANTS);
  const ready = useCommunity((s) => s.ready);
  const mediaReachable = useCommunity((s) => s.voice.mediaReachable);
  const checkedAt = useCommunity((s) => s.voice.checkedAt);
  const roomsConfirmedAt = useCommunity((s) => s.voice.roomsConfirmedAt);
  const connected = useVoice((s) => s.status === 'connected');
  const selfMuted = useVoice((s) => s.micMuted || s.deafened);
  const selfDeafened = useVoice((s) => s.deafened);
  const remotes = useVoice((s) => s.remotes);
  const micPublished = useVoice((s) => s.micPublished);
  const me = { userId: self.id, muted: selfMuted, deafened: selfDeafened, micPublished };
  const participants = connected
    ? ownRoomParticipants(
        snapshot,
        presenceDoubt(ready, { mediaReachable, checkedAt, roomsConfirmedAt }),
        me,
        remotes,
      )
    : snapshot;
  const speaking = useVoice((s) => s.speaking);
  const localShare = useVoice((s) => s.localShare);
  const focused = useUi((s) => s.focusedShare);

  const sharers = [
    ...(localShare ? [self.id] : []),
    ...Object.values(remotes)
      .filter((r) => r.screenShare)
      .map((r) => r.userId),
  ];
  const visibleSharers = focused && sharers.includes(focused) ? [focused] : sharers;
  const sharerKey = sharers.join(',');
  useEffect(() => {
    const live = new Set(sharerKey.split(','));
    for (const id of beamShown) if (!live.has(id)) beamShown.delete(id);
  }, [sharerKey]);

  const tileProps = (p: (typeof participants)[number]) => {
    const member = members[p.userId];
    const remote = remotes[p.userId];
    const isSelf = p.userId === self.id;
    return {
      userId: p.userId,
      member,
      name: member?.displayName ?? (isSelf ? self.displayName : 'Unknown'),
      color: member?.avatarColor ?? '#525252',
      speaking: !!speaking[p.userId],
      mic: isSelf ? null : micIndicator(withLiveMic(p, me, remotes)),
      deafened: p.selfDeafened,
      quality: remote?.quality,
      isSelf,
    };
  };

  if (sharers.length === 0) {
    return (
      <div className={styles.call}>
        <Gallery count={participants.length} connected={connected}>
          {(width, height) =>
            participants.map((p) => (
              <motion.div
                key={p.userId}
                layout="position"
                style={{ width, height }}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              >
                <LargeTile {...tileProps(p)} width={width} height={height} />
              </motion.div>
            ))
          }
        </Gallery>
      </div>
    );
  }

  return (
    <div className={styles.call}>
      <div className={`${styles.stage} ${visibleSharers.length === 1 ? styles.stageFocused : ''}`}>
        {visibleSharers.map((userId) => (
          <ShareTile
            key={userId}
            userId={userId}
            name={userId === self.id ? 'Your screen' : (members[userId]?.displayName ?? 'Someone')}
            isLocal={userId === self.id}
            focused={focused === userId}
            canFocus={sharers.length > 1 || focused === userId}
          />
        ))}
      </div>

      <div className={styles.tiles} data-testid="participant-tiles">
        {participants.map((p) => (
          <ParticipantTile key={p.userId} {...tileProps(p)} />
        ))}
      </div>
    </div>
  );
}

function Gallery({
  count,
  connected,
  children,
}: {
  count: number;
  connected: boolean;
  children: (width: number, height: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const fit = fitGallery(count, size.width, size.height, GALLERY_GAP);
  return (
    <div ref={box} className={styles.gallery} data-testid="participant-tiles">
      {count === 0 ? (
        <span className={styles.galleryWaiting}>
          <Spinner label={connected ? 'Updating' : 'Connecting'} />{' '}
          {connected ? 'Updating who is here…' : 'Connecting…'}
        </span>
      ) : (
        <div
          className={styles.galleryRows}
          style={{
            width: fit.columns * fit.width + (fit.columns - 1) * GALLERY_GAP,
            gap: GALLERY_GAP,
          }}
        >
          {children(fit.width, fit.height)}
        </div>
      )}
    </div>
  );
}

function ShareTile({
  userId,
  name,
  isLocal,
  focused,
  canFocus,
}: {
  userId: string;
  name: string;
  isLocal: boolean;
  focused: boolean;
  canFocus: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamVolume = useVoice((s) => s.streamVolumes[userId] ?? 1);
  const hasStreamAudio = useVoice((s) =>
    isLocal ? !!s.localShare?.hasAudio : !!s.remotes[userId]?.screenShareAudio,
  );
  const deafened = useVoice((s) => s.deafened);
  const ducked = useVoice((s) => s.duckingNow && !isLocal && !!s.remotes[userId]?.screenShareAudio);
  const [beam] = useState(() => !beamShown.has(userId));
  useEffect(() => {
    beamShown.add(userId);
  }, [userId]);

  useTrackVersion();
  const track = voice().getScreenShareTrack(userId);
  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  useEffect(() => (isLocal ? undefined : voice().watchShare(userId)), [isLocal, userId]);

  return (
    <div
      className={styles.share}
      data-testid={`share-tile-${isLocal ? 'local' : 'remote'}`}
      data-ducked={ducked || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openPopup({ kind: 'share-menu', userId, x: e.clientX, y: e.clientY });
      }}
    >
      {beam && (
        <span className={styles.beamFrame} aria-hidden>
          <span className={styles.beam} />
        </span>
      )}
      <video
        ref={videoRef}
        className={styles.shareVideo}
        data-share-video=""
        muted
        autoPlay
        playsInline
        data-testid={`share-video-${isLocal ? 'local' : 'remote'}`}
      />
      <div className={styles.shareBar}>
        <span className={styles.shareName}>
          {isLocal ? 'You are sharing your screen' : `${name} is sharing`}
        </span>
        {ducked && <span className={styles.duckedTag}>lowered while someone talks</span>}
        {!isLocal &&
          (hasStreamAudio ? (
            <span className={styles.shareVolume}>
              {deafened ? <VolumeX size={14} /> : <Volume2 size={14} />}
              {maxVolume() > 0 && (
                <Slider
                  label={`Stream volume for ${name}`}
                  min={0}
                  max={maxVolume()}
                  value={effectiveVolume(streamVolume)}
                  onChange={(v) => voice().setStreamVolume(userId, v)}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
              )}
            </span>
          ) : (
            <span className={styles.noAudioTag}>video only</span>
          ))}
        {isLocal && (
          <span className={styles.noAudioTag}>{hasStreamAudio ? 'with audio' : 'video only'}</span>
        )}
        {canFocus && (
          <IconButton
            label={focused ? 'Show all streams' : 'Enlarge this stream'}
            icon={focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            onClick={() => useUi.setState({ focusedShare: focused ? null : userId })}
          />
        )}
        <IconButton
          label="Fullscreen"
          icon={<Maximize2 size={15} />}
          onClick={() => enterVideoFullscreen(videoRef.current)}
        />
        {isLocal && (
          <IconButton
            label="Stop sharing"
            tone="danger"
            icon={<PhoneOff size={15} />}
            onClick={() => void voice().stopScreenShare()}
          />
        )}
      </div>
    </div>
  );
}

interface TileProps {
  userId: string;
  member: UserPublic | undefined;
  name: string;
  color: string;
  speaking: boolean;
  mic: MicIndicator;
  deafened: boolean;
  quality: string | undefined;
  isSelf: boolean;
}

function TileMeta({ userId, mic, deafened, quality, isSelf }: TileProps) {
  const selfDeafened = useVoice((s) => s.deafened);
  const silencedHere = useVoice(
    (s) =>
      mutedForMe(!!s.localMutes[userId], s.volumes[userId]) ||
      effectiveVolume(s.volumes[userId] ?? 1) === 0,
  );
  return (
    <span className={styles.tileMeta}>
      {isSelf && <span>you</span>}
      {mic === 'muted' && <MicOff size={12} aria-label="Muted" />}
      {mic === 'no-microphone' && (
        <MicOff size={12} className={styles.noMic} aria-label="No microphone" />
      )}
      {deafened && <VolumeX size={12} aria-label="Deafened" />}
      {quality === 'poor' && <span className={styles.qualityPoor}>weak connection</span>}
      {quality === 'lost' && <span className={styles.qualityLost}>connection lost</span>}
      {isSelf && selfDeafened && <span>you are deafened</span>}
      {silencedHere && <span>muted for you</span>}
    </span>
  );
}

function TileBackdrop({ user }: { user: UserPublic | undefined }) {
  const reduced = useReducedMotion();
  const url = user?.bannerUrl ? mediaUrl(user.bannerUrl) : null;
  const filesBlocked = useFilesBlocked();
  const [still, setStill] = useState<{ url: string; frame: string | null } | null>(null);
  useEffect(() => {
    if (!url || !reduced || filesBlocked) return;
    let alive = true;
    void stillFrame(url).then((frame) => {
      if (alive) setStill({ url, frame });
    });
    return () => {
      alive = false;
    };
  }, [url, reduced, filesBlocked]);
  const src = reduced ? (still?.url === url ? still?.frame : null) : url;
  const color = user?.bannerColor ?? user?.avatarColor ?? '#2e2e2e';
  return (
    <span
      className={styles.backdrop}
      style={{
        background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 68%, #0a0a0a))`,
      }}
      aria-hidden
    >
      {src && (
        <img
          key={String(filesBlocked)}
          src={src}
          alt=""
          draggable={false}
          data-testid="tile-backdrop-image"
        />
      )}
    </span>
  );
}

function useTagBox() {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<TagBox | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const tile = node?.offsetParent;
    if (!node || !(tile instanceof HTMLElement)) return;
    const read = () => {
      const next = {
        left: node.offsetLeft,
        bottom: tile.offsetHeight - node.offsetTop - node.offsetHeight,
        width: node.offsetWidth,
        height: node.offsetHeight,
      };
      setBox((now) =>
        now &&
        now.left === next.left &&
        now.bottom === next.bottom &&
        now.width === next.width &&
        now.height === next.height
          ? now
          : next,
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, box };
}

function LargeTile({ width, height, ...tile }: TileProps & { width: number; height: number }) {
  const { userId, member, name, color, speaking } = tile;
  const { ref: tagRef, box: tagBox } = useTagBox();
  const avatar = largeAvatarSize(width, height, tagBox);
  return (
    <button
      type="button"
      className={cx(styles.largeTile, speaking && styles.largeTileSpeaking)}
      data-testid="participant-tile"
      data-user={userId}
      data-speaking={speaking || undefined}
      {...memberTrigger(userId)}
    >
      <TileBackdrop user={member} />
      <span className={styles.largeAvatar}>
        <Avatar name={name} color={color} src={member?.avatarUrl} size={avatar} animate />
      </span>
      <span ref={tagRef} className={styles.largeLabel}>
        <span className={styles.largeName}>
          <NameText user={member ?? { displayName: name }} live />
        </span>
        <TileMeta {...tile} />
      </span>
    </button>
  );
}

function ParticipantTile(tile: TileProps) {
  const { userId, member, name, color, speaking } = tile;
  return (
    <button
      type="button"
      className={`${styles.tile} ${speaking ? styles.tileSpeaking : ''}`}
      data-testid="participant-tile"
      data-user={userId}
      data-speaking={speaking || undefined}
      {...memberTrigger(userId)}
    >
      <Avatar name={name} color={color} src={member?.avatarUrl} size={32} animate />
      <span className={styles.tileBody}>
        <span className={styles.tileName}>
          <NameText user={member ?? { displayName: name }} live />
        </span>
        <TileMeta {...tile} />
      </span>
    </button>
  );
}
