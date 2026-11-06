export const SHORTCUT_ACTIONS = ['toggleMute', 'toggleDeafen', 'fullscreenShare'] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export type ShortcutBindings = Record<ShortcutAction, string | null>;

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  toggleMute: 'Mute',
  toggleDeafen: 'Deafen',
  fullscreenShare: 'Fullscreen stream',
};

export interface KeyPress {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'AltGraph',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock',
  'Fn',
  'FnLock',
  'OSLeft',
  'OSRight',
]);

export function bindingFromPress(press: KeyPress): string | null {
  if (!press.code || press.code === 'Unidentified' || MODIFIER_CODES.has(press.code)) return null;
  const parts: string[] = [];
  if (press.ctrlKey) parts.push('Ctrl');
  if (press.metaKey) parts.push('Cmd');
  if (press.altKey) parts.push('Alt');
  if (press.shiftKey) parts.push('Shift');
  parts.push(press.code);
  return parts.join('+');
}

export function defaultBindings(mac: boolean): Record<ShortcutAction, string> {
  const mod = mac ? 'Cmd' : 'Ctrl';
  return {
    toggleMute: `${mod}+Shift+KeyM`,
    toggleDeafen: `${mod}+Shift+KeyD`,
    fullscreenShare: `${mod}+Shift+KeyF`,
  };
}

export function isMacLike(): boolean {
  return /mac|iphone|ipad/i.test(typeof navigator === 'undefined' ? '' : navigator.platform);
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

function codeLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1]!;
  const numpad = /^Numpad(.+)$/.exec(code);
  if (numpad) return `Numpad ${numpad[1]}`;
  return CODE_LABELS[code] ?? code;
}

export function bindingKeys(binding: string, mac: boolean): string[] {
  const parts = binding.split('+');
  const code = parts.pop()!;
  const names = parts.map((p) => (p === 'Alt' && mac ? 'Option' : p));
  return [...names, codeLabel(code)];
}

export function formatBinding(binding: string, mac: boolean): string {
  return bindingKeys(binding, mac).join(' + ');
}

const PAGE_KEYS = new Set([
  'Tab',
  'Enter',
  'NumpadEnter',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

const RESERVED_BARE = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12', 'PrintScreen']);

const RESERVED_WITH_MOD = new Set([
  'KeyA',
  'KeyC',
  'KeyV',
  'KeyX',
  'KeyY',
  'KeyZ',
  'KeyN',
  'KeyQ',
  'KeyT',
  'KeyW',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyL',
  'KeyM',
  'KeyO',
  'KeyP',
  'KeyR',
  'KeyS',
  'KeyU',
  'Equal',
  'Minus',
  'Digit0',
]);

const RESERVED_WITH_MOD_SHIFT = new Set([
  'KeyC',
  'KeyI',
  'KeyJ',
  'KeyN',
  'KeyP',
  'KeyQ',
  'KeyR',
  'KeyT',
  'KeyV',
  'KeyW',
  'KeyZ',
  'Digit3',
  'Digit4',
  'Digit5',
]);

export function refusalFor(binding: string): string | null {
  const parts = binding.split('+');
  const code = parts[parts.length - 1]!;
  const has = (m: string) => parts.slice(0, -1).includes(m);
  const mod = has('Ctrl') || has('Cmd');
  const bare = parts.length === 1;

  if (PAGE_KEYS.has(code)) {
    return 'That key is needed to move around the page and edit text. Pick another.';
  }
  if (bare && RESERVED_BARE.has(code)) return 'Your browser keeps that key for itself.';
  if (code === 'F4' && has('Alt')) return 'That closes the window.';
  if (has('Alt') && code === 'Tab') return 'Your system keeps that combination for itself.';
  if (mod && !has('Alt')) {
    if (!has('Shift') && RESERVED_WITH_MOD.has(code)) {
      return 'Your browser or text fields already use that combination. Pick another.';
    }
    if (has('Shift') && RESERVED_WITH_MOD_SHIFT.has(code)) {
      return 'Your browser or system already uses that combination. Pick another.';
    }
  }
  return null;
}

export function conflictFor(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  binding: string,
): ShortcutAction | null {
  return SHORTCUT_ACTIONS.find((other) => other !== action && bindings[other] === binding) ?? null;
}

const BINDING_SHAPE = /^(Ctrl\+)?(Cmd\+)?(Alt\+)?(Shift\+)?[A-Za-z0-9]+$/;

export function sanitizeBindings(stored: unknown, mac: boolean): ShortcutBindings {
  const defaults = defaultBindings(mac);
  const source =
    stored && typeof stored === 'object'
      ? (stored as Partial<Record<ShortcutAction, unknown>>)
      : {};
  const result: ShortcutBindings = { ...defaults };
  const taken = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const value = source[action];
    if (value === null) {
      result[action] = null;
      continue;
    }
    const usable =
      typeof value === 'string' && BINDING_SHAPE.test(value) && !refusalFor(value)
        ? value
        : defaults[action];
    if (taken.has(usable)) {
      result[action] = null;
      continue;
    }
    taken.add(usable);
    result[action] = usable;
  }
  return result;
}

export function actionFor(bindings: ShortcutBindings, binding: string): ShortcutAction | null {
  const exact = SHORTCUT_ACTIONS.find((a) => bindings[a] === binding);
  if (exact) return exact;
  if (!/\+(Alt|Shift)\+/.test(binding) || /Ctrl\+Cmd/.test(binding)) return null;
  const other = binding.includes('Ctrl+')
    ? binding.replace('Ctrl+', 'Cmd+')
    : binding.replace('Cmd+', 'Ctrl+');
  return SHORTCUT_ACTIONS.find((a) => bindings[a] === other) ?? null;
}

export function firesWhileTyping(press: KeyPress, altGraph: boolean, mac: boolean): boolean {
  if (altGraph) return false;
  if (press.ctrlKey || press.metaKey) return true;
  if (press.altKey) return !mac;
  return press.key.length > 1 && press.key !== 'Dead' && press.key !== 'Process';
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function isTextTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target.closest('[contenteditable="true"], textarea, select')) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}
