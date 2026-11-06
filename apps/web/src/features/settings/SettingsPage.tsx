import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, Hash, Play, Plus, Volume2, X } from 'lucide-react';
import { motion } from 'motion/react';
import {
  LIMITS,
  type AdminUserDTO,
  type ArchivedChannelDTO,
  type ChannelDTO,
} from '@hostile/shared';
import { endpoints, errorMessage } from '../../api/client';
import { leaveRoom } from '../../app/session';
import {
  Avatar,
  Banner,
  Button,
  cx,
  Field,
  IconButton,
  Select,
  Slider,
  Switch,
  uiStyles,
  useDialog,
} from '../../components/ui';
import { formatDate, formatFull } from '../../lib/time';
import { desktopRoom } from '../../platform';
import { sortChannels, useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { toast, useUi, type SettingsTab } from '../../stores/ui';
import { NameText, OwnerMark } from '../profile/NameText';
import { ProfileTab } from '../profile/ProfileTab';
import { ShortcutsTab } from '../shortcuts/ShortcutsTab';
import { MicTest } from '../voice/MicTest';
import {
  SUPPRESSOR_MODE_NAMES,
  suppressorFor,
  type NoiseSuppressionMode,
} from '../voice/audio-processing';
import { voice, type VoiceDiagnostics } from '../voice/controller';
import { maxVolume } from '../voice/audio-route';
import { DUCKING_LEVEL_MAX, DUCKING_LEVEL_MIN } from '../voice/ducking';
import { CUE_LABELS, previewCue } from '../voice/sounds';
import { useVoice } from '../voice/store';
import { ConfirmButton, Group } from './Group';
import { useJoinRequests } from '../join/JoinRequests';
import { HostingTab } from './HostingTab';
import { NoticesLink } from './NoticesLink';
import styles from './settings.module.scss';

interface TabInfo {
  id: SettingsTab;
  label: string;
  ownerOnly?: boolean;
  roomOnly?: boolean;
}

const GROUPS: { title: string; tabs: TabInfo[] }[] = [
  {
    title: 'You',
    tabs: [{ id: 'profile', label: 'Profile' }],
  },
  {
    title: 'Calls',
    tabs: [
      { id: 'voice', label: 'Voice & audio' },
      { id: 'shortcuts', label: 'Shortcuts' },
    ],
  },
  {
    title: 'Community',
    tabs: [
      { id: 'members', label: 'Members', ownerOnly: true },
      { id: 'channels', label: 'Channels', ownerOnly: true },
    ],
  },
  {
    title: 'This app',
    tabs: [
      { id: 'hosting', label: 'Hosting', roomOnly: true },
      { id: 'diagnostics', label: 'Diagnostics' },
    ],
  },
];

export function SettingsPage() {
  const tab = useUi((s) => s.settingsTab)!;
  const self = useSession((s) => s.user!);
  const role = desktopRoom()?.role;
  const asking = useJoinRequests((s) => s.requests.length > 0);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => useUi.setState({ settingsTab: null });
  useDialog(ref, close);
  useEffect(() => useUi.setState({ navOpen: false }), []);

  const groups = GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs
      .filter(
        (t) =>
          (!t.ownerOnly || self.role === 'owner') &&
          (!t.roomOnly || role === 'host' || role === 'guest'),
      )
      .map((t) => (t.id === 'hosting' && role === 'guest' ? { ...t, label: 'Room' } : t)),
  })).filter((group) => group.tabs.length > 0);
  const current = groups.flatMap((g) => g.tabs).find((t) => t.id === tab);

  return (
    <motion.div
      ref={ref}
      className={styles.page}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      initial={{ opacity: 0, scale: 1.012 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.008 }}
      transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
    >
      <div className={styles.navColumn}>
        <nav className={styles.nav} aria-label="Settings sections">
          <h2 id={titleId} className={styles.pageTitle}>
            Settings
          </h2>
          {groups.map((group) => (
            <div key={group.title} className={styles.navGroup}>
              <div className={styles.navGroupTitle}>{group.title}</div>
              {group.tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={styles.tab}
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => useUi.setState({ settingsTab: t.id })}
                >
                  {tab === t.id && (
                    <motion.span
                      layoutId="settings-tab"
                      className={styles.tabPill}
                      transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
                    />
                  )}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
          {self.role !== 'owner' && role !== 'guest' && (
            <div className={styles.navSignOut}>
              <ConfirmButton
                label="Leave"
                question="Coming back means being someone new. Leave?"
                onConfirm={async () => {
                  await leaveRoom();
                }}
              />
            </div>
          )}
        </nav>
      </div>

      <div className={styles.content}>
        <div className={styles.closeBox}>
          <IconButton label="Close" icon={<X size={18} />} onClick={close} data-close tipBelow />
        </div>
        <div key={tab} className={styles.panel} data-testid="settings-panel">
          <div
            className={`${styles.panelInner} ${styles.panelEnter} ${asking && tab !== 'hosting' ? styles.panelBesideCard : ''}`}
          >
            <h2 className={styles.panelTitle}>{current?.label}</h2>
            <div
              className={
                tab === 'profile' || tab === 'members' || tab === 'diagnostics' || tab === 'hosting'
                  ? styles.panelStack
                  : styles.panelColumns
              }
            >
              {tab === 'profile' && <ProfileTab />}
              {tab === 'voice' && <VoiceTab />}
              {tab === 'shortcuts' && <ShortcutsTab />}
              {tab === 'hosting' && <HostingTab />}
              {tab === 'diagnostics' && <DiagnosticsTab />}
              {tab === 'members' && <MembersTab />}
              {tab === 'channels' && <ChannelsTab />}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function VoiceTab() {
  const v = useVoice();
  const inCall = v.status !== 'idle';
  const selectedSuppressor = suppressorFor(v.processing.noiseMode);
  useEffect(() => {
    void voice().refreshDevices();
  }, []);

  const inputOptions = [
    { value: 'default', label: 'System default' },
    ...v.devices.input
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .map((d) => ({ value: d.deviceId, label: d.label || 'Microphone' })),
  ];
  const outputOptions = [
    { value: 'default', label: 'System default' },
    ...v.devices.output
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .map((d) => ({ value: d.deviceId, label: d.label || 'Speakers' })),
  ];

  return (
    <>
      <Group title="Devices">
        {v.devices.input.length === 0 && (
          <Banner kind="info">
            Device names appear once you allow the microphone: join a call or run the test below.
          </Banner>
        )}
        <Field label="Microphone">
          {(id) => (
            <Select
              id={id}
              value={v.inputDeviceId}
              options={inputOptions}
              onChange={(value) => void voice().setInputDevice(value)}
            />
          )}
        </Field>
        <Field
          label="Output"
          hint={
            v.outputSelectionSupported
              ? undefined
              : 'This browser follows the system output and cannot choose one.'
          }
        >
          {(id) => (
            <Select
              id={id}
              value={v.outputDeviceId}
              options={outputOptions}
              disabled={!v.outputSelectionSupported}
              onChange={(value) => void voice().setOutputDevice(value)}
            />
          )}
        </Field>
        <MicTest />
      </Group>

      <Group
        title="Your microphone"
        hint={inCall ? 'Changing these restarts your microphone for a moment.' : undefined}
      >
        <Field
          label="Noise suppression"
          hint="Enhanced removes steady noise such as fans and hum. Strong also removes keyboards and clatter, but uses far more CPU and drops to Standard if your computer cannot keep up. Both add a little delay."
        >
          {(id, describedBy) => (
            <Select
              id={id}
              testId="noise-mode"
              aria-describedby={describedBy}
              disabled={v.processingBusy}
              value={v.processing.noiseMode}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'standard', label: 'Standard (built-in)' },
                { value: 'enhanced', label: 'Enhanced (RNNoise)' },
                { value: 'strong', label: 'Strong (FastEnhancer)' },
              ]}
              onChange={(value) =>
                void voice().setProcessing({
                  ...v.processing,
                  noiseMode: value as NoiseSuppressionMode,
                  noiseModeChosen: true,
                })
              }
            />
          )}
        </Field>
        {selectedSuppressor &&
          v.suppressorFailures[selectedSuppressor] &&
          (v.processing.noiseModeChosen ? (
            <Banner kind="warning">
              {SUPPRESSOR_MODE_NAMES[selectedSuppressor]} noise suppression could not start on this
              device ({v.suppressorFailures[selectedSuppressor]}), so the standard one is being
              used. Your choice is kept; it will be tried again next time you open the app.
            </Banner>
          ) : (
            <Banner kind="info">
              {SUPPRESSOR_MODE_NAMES[selectedSuppressor]} noise suppression did not run on this
              device ({v.suppressorFailures[selectedSuppressor]}), so Standard (built-in) is on for
              now. It will be tried again next time you open the app.
            </Banner>
          ))}
        <Switch
          checked={v.processing.echoCancellation}
          onChange={(value) =>
            void voice().setProcessing({ ...v.processing, echoCancellation: value })
          }
          label="Echo cancellation"
          description="For speakers rather than headphones."
        />
        <Switch
          checked={v.processing.autoGainControl}
          onChange={(value) =>
            void voice().setProcessing({ ...v.processing, autoGainControl: value })
          }
          label="Automatic gain control"
          description="Evens out your volume. Turn off with a mixer or interface."
        />
      </Group>

      <div className={styles.voiceLower}>
        {maxVolume() > 0 && (
          <Group title="Streams">
            <Switch
              checked={v.streamDucking}
              onChange={(value) => useVoice.setState({ streamDucking: value })}
              label="Lower streams when others talk"
              description="Stream audio drops while someone else speaks. Your own voice never lowers it."
              testId="stream-ducking"
            />
            {v.streamDucking && (
              <div className={styles.sliderRow}>
                <span>Lower to</span>
                <Slider
                  label="Stream level while someone talks"
                  min={DUCKING_LEVEL_MIN}
                  max={DUCKING_LEVEL_MAX}
                  value={v.duckingLevel}
                  onChange={(value) => useVoice.setState({ duckingLevel: value })}
                  format={(value) => `${Math.round(value * 100)}%`}
                />
                <span className={styles.sliderValue}>{Math.round(v.duckingLevel * 100)}%</span>
              </div>
            )}
          </Group>
        )}

        <Group title="Sounds">
          <Switch
            checked={v.callSounds}
            onChange={(value) => useVoice.setState({ callSounds: value })}
            label="Call sounds"
            description="For joins, leaves, mute, deafen and screen shares. Only you hear them."
          />
          <div className={styles.cueGrid}>
            {CUE_LABELS.map(({ cue, label }) => (
              <Button key={cue} small variant="ghost" onClick={() => previewCue(cue)}>
                <Play size={12} /> {label}
              </Button>
            ))}
          </div>
        </Group>
      </div>
    </>
  );
}

function DiagnosticsTab() {
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [health, setHealth] = useState<string>('checking…');
  const connection = useCommunity((s) => s.connection);
  const mediaReachable = useCommunity((s) => s.voice.mediaReachable);
  const mediaCheckedAt = useCommunity((s) => s.voice.checkedAt);
  const members = useCommunity((s) => s.members);
  const status = useVoice((s) => s.status);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await voice().diagnostics();
      if (alive) setDiag(d);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    void endpoints
      .health()
      .then(
        (h) =>
          alive &&
          setHealth(`${h.status} · database ${h.database} · media ${h.media} · up ${h.uptimeSec}s`),
      )
      .catch((err) => alive && setHealth(errorMessage(err)));
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <Group title="Connection">
        <dl className={styles.definitions}>
          <dt>Application socket</dt>
          <dd data-testid="diag-socket">{connection}</dd>
          <dt>Server health</dt>
          <dd data-testid="diag-health">{health}</dd>
          <dt>Media server reachable from API</dt>
          <dd>{mediaCheckedAt ? (mediaReachable ? 'yes' : 'no') : 'not checked yet'}</dd>
          <dt>Voice state</dt>
          <dd data-testid="diag-voice-state">{status}</dd>
          {diag && (
            <>
              <dt>Media server</dt>
              <dd>{diag.serverUrl}</dd>
              <dt>Media path</dt>
              <dd data-testid="diag-candidate">
                {diag.candidateType
                  ? `${diag.candidateType} / ${diag.protocol}`
                  : 'not established'}
              </dd>
              <dt>Sent audio</dt>
              <dd data-testid="diag-audio-sent">
                {diag.localAudio ? `${diag.localAudio.bytesSent} bytes` : 'no microphone published'}
              </dd>
              <dt>Noise suppression</dt>
              <dd data-testid="diag-noise-suppression">
                {diag.noiseSuppression.mode}
                {diag.noiseSuppression.processor ? ` (${diag.noiseSuppression.processor})` : ''}
              </dd>
              <dt>Suppressors that failed</dt>
              <dd data-testid="diag-noise-failures">
                {diag.noiseSuppression.failures.join('; ') || 'none'}
              </dd>
            </>
          )}
        </dl>
      </Group>

      <Group
        title="Incoming media"
        hint="Rising bytes and samples mean media really is arriving. Level is measured by the media server; energy reads 0 on a machine with no audio output."
      >
        {!diag || diag.remotes.length === 0 ? (
          <p className={styles.hint}>Nobody else is in the call, so there is nothing to measure.</p>
        ) : (
          <table className={styles.table} data-testid="diag-remotes">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Audio bytes</th>
                <th>Samples</th>
                <th>Energy</th>
                <th>Level</th>
                <th>Screen frames</th>
                <th>Screen size</th>
                <th>Stream audio</th>
                <th>Stream volume</th>
              </tr>
            </thead>
            <tbody>
              {diag.remotes.map((r) => (
                <tr key={r.userId} data-testid="diag-remote" data-user={r.userId}>
                  <td>{members[r.userId]?.displayName ?? r.userId.slice(0, 8)}</td>
                  <td data-testid="diag-audio-bytes">{r.audioBytesReceived ?? '—'}</td>
                  <td data-testid="diag-audio-samples">{r.audioSamplesReceived ?? '—'}</td>
                  <td data-testid="diag-audio-energy">
                    {r.audioEnergy !== null ? r.audioEnergy.toFixed(4) : '—'}
                  </td>
                  <td data-testid="diag-audio-level">{r.audioLevel.toFixed(3)}</td>
                  <td data-testid="diag-video-frames">{r.screenFramesDecoded ?? '—'}</td>
                  <td>{r.screenSize ?? '—'}</td>
                  <td>{r.screenAudioBytesReceived ?? '—'}</td>
                  <td data-testid="diag-stream-volume">
                    {r.screenAudioVolume !== null ? r.screenAudioVolume.toFixed(2) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Group>
      <NoticesLink />
    </>
  );
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'success');
  } catch {
    toast('Could not copy. Select the code above and copy it manually.', 'error');
  }
}

function MembersTab() {
  const [users, setUsers] = useState<AdminUserDTO[] | null>(null);
  const online = useCommunity((s) => s.online);

  const refresh = useCallback(async () => {
    try {
      setUsers((await endpoints.admin.users()).users);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  return (
    <>
      <Group hint="Removing someone cuts them off at once. Their messages stay. With the code they could only ask to join again, as someone new.">
        <div className={styles.list}>
          {users?.map((u) => (
            <div
              key={u.id}
              className={cx(styles.listRow, styles.memberRow)}
              data-testid="member-row"
              data-member={u.id}
              data-avatar-host
            >
              <Avatar
                name={u.displayName}
                color={u.avatarColor}
                src={u.avatarUrl}
                size={36}
                online={!!online[u.id]}
              />
              <div className={styles.listText}>
                <div className={styles.listTitle}>
                  <NameText user={u} />
                  {u.role === 'owner' && <OwnerMark />}
                </div>
              </div>
              <div className={styles.listFacts}>
                <span title={formatFull(u.createdAt)}>Joined {formatDate(u.createdAt)}</span>
              </div>
              <div className={styles.memberActions}>
                {u.role !== 'owner' && (
                  <ConfirmButton
                    label="Remove"
                    question={`Remove ${u.displayName}?`}
                    onConfirm={async () => {
                      await endpoints.admin.removeUser(u.id);
                      await refresh();
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}

const CHANNEL_TYPES = [
  { type: 'text', title: 'Text channels', icon: Hash, placeholder: 'New text channel' },
  { type: 'voice', title: 'Voice channels', icon: Volume2, placeholder: 'New voice channel' },
] as const;

function ChannelsTab() {
  const channels = useCommunity((s) => s.channels);
  const [reordering, setReordering] = useState(false);
  const [archived, setArchived] = useState<ArchivedChannelDTO[] | null>(null);
  const sorted = useMemo(() => sortChannels(channels), [channels]);

  const refreshArchived = useCallback(async () => {
    try {
      const res = await endpoints.admin.archivedChannels();
      setArchived(res.channels);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await refreshArchived();
    })();
    return () => {
      alive = false;
    };
  }, [refreshArchived]);

  async function move(id: string, type: ChannelDTO['type'], delta: number) {
    const own = sorted.filter((c) => c.type === type);
    const rest = sorted.filter((c) => c.type !== type);
    const index = own.findIndex((c) => c.id === id);
    const [moved] = own.splice(index, 1);
    own.splice(index + delta, 0, moved!);
    setReordering(true);
    try {
      await endpoints.admin.reorderChannels([...own, ...rest].map((c) => c.id));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setReordering(false);
    }
  }

  return (
    <>
      {CHANNEL_TYPES.map(({ type, title, icon: Icon, placeholder }) => {
        const own = sorted.filter((c) => c.type === type);
        return (
          <Group key={type} title={title}>
            <ul className={styles.list}>
              {own.map((c, index) => (
                <li key={c.id} className={styles.listRow} data-testid="channel-row">
                  <Icon size={16} className={styles.channelIcon} aria-hidden />
                  <ChannelNameEditor key={c.name} id={c.id} name={c.name} />
                  <div className={styles.listActions}>
                    <IconButton
                      label={`Move ${c.name} up`}
                      icon={<ArrowUp size={15} />}
                      disabled={index === 0 || reordering}
                      onClick={() => void move(c.id, type, -1)}
                    />
                    <IconButton
                      label={`Move ${c.name} down`}
                      icon={<ArrowDown size={15} />}
                      disabled={index === own.length - 1 || reordering}
                      onClick={() => void move(c.id, type, 1)}
                    />
                    <ConfirmButton
                      label="Archive"
                      icon={<Archive size={15} />}
                      question={`Archive ${c.name}?`}
                      onConfirm={async () => {
                        await endpoints.admin
                          .archiveChannel(c.id)
                          .catch((err) => toast(errorMessage(err), 'error'));
                        await refreshArchived();
                      }}
                    />
                  </div>
                </li>
              ))}
              <NewChannelRow type={type} placeholder={placeholder} />
            </ul>
          </Group>
        );
      })}

      <Group
        title="Archived"
        hint="Archiving hides a channel for everyone and closes its voice room. Its messages are kept, and Restore brings it back with them."
      >
        {archived?.length === 0 ? (
          <p className={styles.listEmpty}>Nothing is archived.</p>
        ) : (
          <ul className={styles.list}>
            {(archived ?? []).map((c) => {
              const Icon = c.type === 'voice' ? Volume2 : Hash;
              return (
                <li key={c.id} className={styles.listRow} data-testid="archived-row">
                  <Icon size={16} className={styles.channelIcon} aria-hidden />
                  <div className={styles.listText}>
                    <div className={styles.listTitle}>{c.name}</div>
                    <div className={styles.listMeta}>Archived {formatDate(c.archivedAt)}</div>
                  </div>
                  <Button
                    small
                    onClick={async () => {
                      await endpoints.admin
                        .restoreChannel(c.id)
                        .catch((err) => toast(errorMessage(err), 'error'));
                      await refreshArchived();
                    }}
                  >
                    Restore
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
    </>
  );
}

function NewChannelRow({ type, placeholder }: { type: 'text' | 'voice'; placeholder: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await endpoints.admin.createChannel({ name: name.trim(), type });
      setName('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.listRow}>
      <Plus size={16} className={styles.channelIcon} aria-hidden />
      <input
        className={cx(uiStyles.input, styles.inlineInput)}
        value={name}
        maxLength={LIMITS.channelNameMax}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
      />
      <Button small busy={busy} disabled={!name.trim()} onClick={() => void create()}>
        Create
      </Button>
    </li>
  );
}

function ChannelNameEditor({ id, name }: { id: string; name: string }) {
  const [value, setValue] = useState(name);
  return (
    <input
      className={cx(uiStyles.input, styles.inlineInput)}
      value={value}
      maxLength={LIMITS.channelNameMax}
      aria-label={`Rename ${name}`}
      data-own-escape={value !== name || undefined}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setValue(name);
      }}
      onBlur={() => {
        if (value.trim() && value !== name)
          void endpoints.admin
            .updateChannel(id, { name: value.trim() })
            .catch((err) => toast(errorMessage(err), 'error'));
      }}
    />
  );
}
