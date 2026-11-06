import { useEffect, useState } from 'react';
import { Monitor, AppWindow } from 'lucide-react';
import {
  SCREEN_SHARE_PRESETS,
  type CaptureCapabilities,
  type CaptureSource,
  type ScreenSharePresetId,
} from '@hostile/shared';
import { Banner, Button, Modal, Select, Spinner, Switch } from '../../components/ui';
import { platform } from '../../platform';
import { useUi } from '../../stores/ui';
import { voice } from './controller';
import { useVoice } from './store';
import styles from './voice.module.scss';

const presetOptions = Object.entries(SCREEN_SHARE_PRESETS).map(([value, p]) => ({
  value,
  label: p.label,
}));

export function ScreenSharePicker() {
  const bridge = platform().desktop;
  const close = () => useUi.setState({ screenPickerOpen: false });
  const preset = useVoice((s) => s.screenSharePreset);
  const [withAudio, setWithAudio] = useState(false);
  const [quality, setQuality] = useState<ScreenSharePresetId>(preset);
  const [sources, setSources] = useState<CaptureSource[] | null>(bridge ? null : []);
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [kind, setKind] = useState<'screen' | 'window'>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const [list, capabilities] = await Promise.all([
          bridge.capture.listSources(),
          bridge.capture.getCapabilities(),
        ]);
        if (cancelled) return;
        setSources(list);
        setCaps(capabilities);
        setSelected(list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Could not list screens and windows.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const audioSupported = !bridge || caps?.systemAudio === 'supported';
  const filtered = (sources ?? []).filter((s) => s.kind === kind);

  async function start() {
    setBusy(true);
    await voice().startScreenShare({
      audio: withAudio && audioSupported,
      preset: quality,
      ...(bridge && selected ? { desktopSourceId: selected } : {}),
    });
    setBusy(false);
    close();
  }

  return (
    <Modal title="Share your screen" onClose={close} width={720}>
      {error && <Banner kind="error">{error}</Banner>}
      {bridge && caps?.screenPermission === 'denied' && (
        <Banner kind="warning">
          macOS is blocking screen recording for this app. Allow it in System Settings → Privacy
          &amp; Security → Screen Recording, then restart Hostile.
        </Banner>
      )}

      {bridge ? (
        <>
          <div className={styles.pickerTabs} role="tablist" aria-label="Source type">
            <button
              type="button"
              role="tab"
              className={styles.pickerTab}
              aria-selected={kind === 'screen'}
              onClick={() => setKind('screen')}
            >
              <Monitor size={14} /> Screens
            </button>
            <button
              type="button"
              role="tab"
              className={styles.pickerTab}
              aria-selected={kind === 'window'}
              onClick={() => setKind('window')}
            >
              <AppWindow size={14} /> Windows
            </button>
          </div>
          {sources === null ? (
            <div
              style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)' }}
            >
              <Spinner /> Looking for screens and windows…
            </div>
          ) : filtered.length === 0 ? (
            <Banner kind="info">
              No {kind === 'screen' ? 'screens' : 'windows'} are available to share.
            </Banner>
          ) : (
            <div className={styles.sources} role="listbox" aria-label="Available sources">
              {filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={styles.source}
                  aria-pressed={selected === s.id}
                  onClick={() => setSelected(s.id)}
                  onDoubleClick={() => void start()}
                >
                  <img src={s.thumbnailDataUrl} alt="" />
                  <span className={styles.sourceName}>
                    {s.appIconDataUrl && (
                      <img
                        src={s.appIconDataUrl}
                        alt=""
                        width={14}
                        height={14}
                        style={{ aspectRatio: 'auto' }}
                      />
                    )}
                    {s.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <Banner kind="info">
          Your browser will ask which screen, window or tab to share after you continue. Tick “Share
          audio” in the browser’s own dialog if you want sound; what is available depends on the
          browser and the source.
        </Banner>
      )}

      <div className={styles.pickerFooter}>
        <div className={styles.pickerRow}>
          <label
            htmlFor="share-quality"
            style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }}
          >
            Quality
          </label>
          <div style={{ width: 230 }}>
            <Select
              id="share-quality"
              value={quality}
              onChange={(v) => setQuality(v as ScreenSharePresetId)}
              options={presetOptions}
              aria-label="Screen share quality"
            />
          </div>
        </div>
        <Switch
          checked={withAudio && audioSupported}
          disabled={!audioSupported}
          onChange={setWithAudio}
          label="Share audio from this source"
          description={
            bridge
              ? (caps?.systemAudioNote ?? 'Checking what this system supports…')
              : 'In the browser, audio sharing is offered by the browser’s own picker and is not available for every source.'
          }
        />
        <div className={styles.pickerRow}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Others can enlarge your stream and control its volume separately from voice.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!!bridge && !selected}
              onClick={() => void start()}
            >
              Start sharing
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
