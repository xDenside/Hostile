import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { ShortcutState } from '@hostile/shared';
import { Banner, Button, cx, IconButton } from '../../components/ui';
import { platform } from '../../platform';
import { toast, useUi } from '../../stores/ui';
import { Group } from '../settings/Group';
import settings from '../settings/settings.module.scss';
import { useVoice } from '../voice/store';
import {
  bindingFromPress,
  bindingKeys,
  conflictFor,
  defaultBindings,
  formatBinding,
  isMacLike,
  refusalFor,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type ShortcutAction,
} from './bindings';

const SHORTCUT_NOTES: Record<ShortcutAction, string> = {
  toggleMute: 'Turn your microphone off or on',
  toggleDeafen: 'Stop or start hearing the call',
  fullscreenShare: 'Show the stream on screen at full size',
};

const CHAT_KEYS: { name: string; note?: string; keys: string[] }[] = [
  { name: 'Send', keys: ['Enter'] },
  { name: 'New line', keys: ['Shift', 'Enter'] },
  { name: 'Stop replying or editing', keys: ['Esc'] },
  { name: 'Move through messages', note: 'Back with Shift', keys: ['Tab'] },
  {
    name: 'Actions on a message',
    note: 'The one in focus, or right-click any',
    keys: ['Shift', 'F10'],
  },
];

const MAC_KEYS: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Option: '⌥',
  Shift: '⇧',
};

function Keys({ keys, label, mac }: { keys: string[]; label?: string; mac: boolean }) {
  return (
    <span className={settings.keys} role="img" aria-label={label ?? keys.join(' + ')}>
      {keys.map((key, i) => (
        <kbd key={i} className={settings.keycap} aria-hidden>
          {(mac && MAC_KEYS[key]) || key}
        </kbd>
      ))}
    </span>
  );
}

function useCapturingKeys(capturing: boolean) {
  useEffect(() => {
    if (!capturing) return;
    useUi.setState({ capturingKeys: true });
    return () => useUi.setState({ capturingKeys: false });
  }, [capturing]);
}

export function ShortcutsTab() {
  const isDesktop = platform().kind === 'desktop';
  return (
    <>
      <WindowShortcuts isDesktop={isDesktop} />
      <ChatKeys />
      {isDesktop && <GlobalShortcuts />}
    </>
  );
}

function WindowShortcuts({ isDesktop }: { isDesktop: boolean }) {
  const bindings = useVoice((s) => s.shortcuts);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [problem, setProblem] = useState<{ action: ShortcutAction; text: string } | null>(null);
  const mac = isMacLike();
  const defaults = defaultBindings(mac);
  useCapturingKeys(capturing !== null);
  const anyListening = useUi((s) => s.capturingKeys);

  const stopListening = () => {
    setCapturing(null);
    setProblem(null);
  };

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === 'Escape') {
        stopListening();
        return;
      }
      const binding = bindingFromPress(e);
      if (!binding) return;
      const refusal = refusalFor(binding);
      const taken = conflictFor(useVoice.getState().shortcuts, capturing, binding);
      if (refusal || taken) {
        setProblem({
          action: capturing,
          text: refusal ?? `That is already the shortcut for ${SHORTCUT_LABELS[taken!]}.`,
        });
        return;
      }
      useVoice.setState((s) => ({ shortcuts: { ...s.shortcuts, [capturing]: binding } }));
      stopListening();
    };
    const onBlur = () => stopListening();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [capturing]);

  const setBinding = (action: ShortcutAction, binding: string | null) => {
    setProblem(null);
    useVoice.setState((s) => ({ shortcuts: { ...s.shortcuts, [action]: binding } }));
  };

  return (
    <Group title="Calls">
      <ul className={cx(settings.list, settings.listFill)}>
        {SHORTCUT_ACTIONS.map((action) => {
          const binding = bindings[action];
          const listening = capturing === action;
          const fallback = defaults[action];
          const canRestore = binding !== fallback && !conflictFor(bindings, action, fallback);
          return (
            <li
              key={action}
              className={cx(settings.listRow, settings.shortcutRow)}
              data-testid={`shortcut-${action}`}
            >
              <div className={settings.listText}>
                <div className={settings.listTitle}>{SHORTCUT_LABELS[action]}</div>
                <div className={settings.listMeta}>{SHORTCUT_NOTES[action]}</div>
              </div>
              {listening ? (
                <span className={settings.keysListening}>Press keys…</span>
              ) : binding ? (
                <Keys
                  keys={bindingKeys(binding, mac)}
                  label={formatBinding(binding, mac)}
                  mac={mac}
                />
              ) : (
                <span className={settings.keysNone}>Not set</span>
              )}
              <span className={settings.shortcutActions}>
                {listening ? (
                  <Button small variant="ghost" onClick={stopListening}>
                    Cancel
                  </Button>
                ) : (
                  <Button
                    small
                    disabled={anyListening}
                    onClick={() => {
                      setProblem(null);
                      setCapturing(action);
                    }}
                  >
                    {binding ? 'Change' : 'Set'}
                  </Button>
                )}
                {!listening && canRestore && (
                  <IconButton
                    label="Default"
                    icon={<RotateCcw size={14} />}
                    onClick={() => setBinding(action, fallback)}
                  />
                )}
                {!listening && binding && (
                  <IconButton
                    label="Clear"
                    icon={<X size={15} />}
                    onClick={() => setBinding(action, null)}
                  />
                )}
              </span>
              {problem?.action === action && (
                <div className={settings.rowProblem}>
                  <Banner kind="error">{problem.text}</Banner>
                </div>
              )}
              {listening && !problem && (
                <p className={settings.rowNote}>Press Escape to stop without changing it.</p>
              )}
            </li>
          );
        })}
        <li className={settings.listFoot}>
          {isDesktop
            ? 'These work inside this window. A single letter does nothing while you type in a field.'
            : 'These only work while this tab is the one in front. Your browser keeps some combinations for itself, and a single letter does nothing while you type in a field.'}
        </li>
      </ul>
    </Group>
  );
}

function ChatKeys() {
  const mac = isMacLike();
  return (
    <Group title="Chat">
      <ul className={settings.list}>
        {CHAT_KEYS.map((row) => (
          <li key={row.name} className={settings.listRow}>
            <div className={settings.listText}>
              <div className={settings.listTitle}>{row.name}</div>
              {row.note && <div className={settings.listMeta}>{row.note}</div>}
            </div>
            <Keys keys={row.keys} mac={mac} />
          </li>
        ))}
      </ul>
    </Group>
  );
}

function GlobalShortcuts() {
  const bridge = platform().desktop!;
  const [state, setState] = useState<ShortcutState | null>(null);
  const [capturing, setCapturing] = useState<'toggleMute' | 'toggleDeafen' | null>(null);
  useCapturingKeys(capturing !== null);
  const anyListening = useUi((s) => s.capturingKeys);

  useEffect(() => {
    void bridge.shortcuts.get().then(setState);
  }, [bridge]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Control');
      if (e.metaKey) parts.push('Command');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
      if (!parts.length) return;
      const accelerator = [...parts, key].join('+');
      const next = await bridge.shortcuts.set({
        ...(state?.bindings ?? { toggleMute: null, toggleDeafen: null }),
        [capturing]: accelerator,
      });
      setState(next);
      setCapturing(null);
      if (next.status[capturing] === 'conflict') {
        toast('Another application already uses that shortcut. Pick a different one.', 'error');
      } else if (next.status[capturing] === 'invalid') {
        toast('That key combination is not supported as a global shortcut.', 'error');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, bridge, state]);

  const rows: { id: 'toggleMute' | 'toggleDeafen'; label: string }[] = [
    { id: 'toggleMute', label: 'Mute' },
    { id: 'toggleDeafen', label: 'Deafen' },
  ];

  return (
    <Group
      title="Everywhere (global)"
      hint="These also work while another application is focused. Push-to-talk is not available yet; see docs/LIMITATIONS.md."
    >
      <ul className={settings.list}>
        {rows.map((row) => {
          const binding = state?.bindings[row.id] ?? null;
          const status = state?.status[row.id];
          return (
            <li key={row.id} className={settings.listRow}>
              <div className={settings.listText}>
                <div className={settings.listTitle}>{row.label}</div>
                {status === 'conflict' && (
                  <div className={settings.warn}>In use by another app</div>
                )}
              </div>
              {capturing === row.id ? (
                <span className={settings.keysListening}>Press keys…</span>
              ) : binding ? (
                <Keys keys={binding.split('+')} mac={false} />
              ) : (
                <span className={settings.keysNone}>Not set</span>
              )}
              <span className={settings.shortcutActions}>
                <Button small disabled={anyListening} onClick={() => setCapturing(row.id)}>
                  {binding ? 'Change' : 'Set'}
                </Button>
                {binding && (
                  <IconButton
                    label="Clear"
                    icon={<X size={15} />}
                    onClick={async () =>
                      setState(await bridge.shortcuts.set({ ...state!.bindings, [row.id]: null }))
                    }
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Group>
  );
}
