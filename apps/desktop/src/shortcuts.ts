import { globalShortcut } from 'electron';
import type {
  ShortcutAction,
  ShortcutBindings,
  ShortcutRegistration,
  ShortcutState,
} from '@hostile/shared';
import { log, messageOf } from './log.js';

const ACTIONS: readonly ShortcutAction[] = ['toggleMute', 'toggleDeafen'];

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

const NAMED_KEYS = new Set([
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'printscreen',
  'plus',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
]);

const SINGLE_KEY = /^[a-z0-9`~!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]$/;
const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/;

export function isValidAccelerator(accelerator: string): boolean {
  if (accelerator.length === 0 || accelerator.length > 80) return false;
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  if (parts.length < 2 || parts.some((part) => part === '')) return false;
  const key = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
  if (new Set(modifiers).size !== modifiers.length) return false;
  return SINGLE_KEY.test(key) || FUNCTION_KEY.test(key) || NAMED_KEYS.has(key);
}

export function applyShortcuts(
  bindings: ShortcutBindings,
  onTriggered: (action: ShortcutAction) => void,
): ShortcutState {
  globalShortcut.unregisterAll();
  const status = {} as Record<ShortcutAction, ShortcutRegistration>;
  const accepted: ShortcutBindings = { toggleMute: null, toggleDeafen: null };
  const taken = new Set<string>();

  for (const action of ACTIONS) {
    const accelerator = bindings[action];
    if (!accelerator) {
      status[action] = 'unset';
      continue;
    }
    if (!isValidAccelerator(accelerator)) {
      status[action] = 'invalid';
      continue;
    }
    const normalized = accelerator.toLowerCase();
    if (taken.has(normalized)) {
      status[action] = 'conflict';
      accepted[action] = accelerator;
      continue;
    }
    let registered: boolean;
    try {
      registered = globalShortcut.register(accelerator, () => onTriggered(action));
    } catch (err) {
      log.warn(`registering "${accelerator}" failed: ${messageOf(err)}`);
      status[action] = 'invalid';
      continue;
    }
    accepted[action] = accelerator;
    status[action] = registered ? 'registered' : 'conflict';
    if (registered) taken.add(normalized);
  }

  return { bindings: accepted, status };
}

export function releaseShortcuts(): void {
  globalShortcut.unregisterAll();
}
