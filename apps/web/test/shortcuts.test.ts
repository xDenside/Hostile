import { describe, expect, it } from 'vitest';
import {
  actionFor,
  bindingFromPress,
  conflictFor,
  defaultBindings,
  firesWhileTyping,
  formatBinding,
  refusalFor,
  sanitizeBindings,
  type KeyPress,
} from '../src/features/shortcuts/bindings';

function press(code: string, mods: Partial<KeyPress> = {}): KeyPress {
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : code;
  return { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('a key press as a binding', () => {
  it('names the physical key, so a Russian layout does not change the shortcut', () => {
    expect(bindingFromPress(press('KeyM', { ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+KeyM',
    );
  });

  it('keeps its modifiers in one order however they were pressed', () => {
    expect(
      bindingFromPress(
        press('KeyK', { shiftKey: true, altKey: true, metaKey: true, ctrlKey: true }),
      ),
    ).toBe('Ctrl+Cmd+Alt+Shift+KeyK');
  });

  it('is nothing yet while only modifiers are down', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'MetaLeft', 'AltRight', 'CapsLock', '']) {
      expect(bindingFromPress(press(code, { shiftKey: true }))).toBeNull();
    }
  });

  it('reads back in words', () => {
    expect(formatBinding('Ctrl+Shift+KeyM', false)).toBe('Ctrl + Shift + M');
    expect(formatBinding('Cmd+Alt+Digit3', true)).toBe('Cmd + Option + 3');
    expect(formatBinding('Slash', false)).toBe('/');
    expect(formatBinding('F8', false)).toBe('F8');
  });
});

describe('what cannot be bound', () => {
  it('keeps the keys a keyboard user moves around with', () => {
    for (const key of ['Tab', 'Enter', 'Escape', 'Space', 'ArrowUp', 'Shift+Tab']) {
      expect(refusalFor(key), key).toMatch(/move around/);
    }
  });

  it('keeps them with any modifier too, which is how text is edited', () => {
    for (const key of [
      'Ctrl+Backspace',
      'Cmd+Delete',
      'Ctrl+ArrowLeft',
      'Ctrl+Shift+ArrowRight',
      'Shift+ArrowUp',
      'Alt+ArrowLeft',
      'Cmd+Home',
      'Ctrl+Enter',
    ]) {
      expect(refusalFor(key), key).toMatch(/edit text/);
    }
  });

  it('keeps editing and browser combinations, on either platform', () => {
    for (const key of [
      'Ctrl+KeyC',
      'Cmd+KeyV',
      'Ctrl+KeyT',
      'Cmd+KeyW',
      'Ctrl+KeyL',
      'Cmd+KeyM',
      'Ctrl+Digit1',
      'Ctrl+Shift+KeyI',
      'Cmd+Shift+KeyT',
      'Cmd+Shift+Digit4',
      'F5',
      'F11',
      'Alt+F4',
    ]) {
      expect(refusalFor(key), key).not.toBeNull();
    }
  });

  it('allows what is left, the defaults included', () => {
    for (const key of [
      ...Object.values(defaultBindings(false)),
      ...Object.values(defaultBindings(true)),
      'KeyM',
      'F8',
      'Ctrl+Alt+KeyK',
      'Alt+KeyM',
      'Shift+KeyM',
      'Ctrl+Shift+KeyK',
    ]) {
      expect(refusalFor(key), key).toBeNull();
    }
  });
});

describe('two actions on one key', () => {
  const bindings = defaultBindings(false);

  it('is reported with the action already holding it', () => {
    expect(conflictFor(bindings, 'toggleMute', bindings.toggleDeafen)).toBe('toggleDeafen');
  });

  it('does not count an action as conflicting with itself', () => {
    expect(conflictFor(bindings, 'toggleMute', bindings.toggleMute)).toBeNull();
  });

  it('is not caused by two actions both being unset', () => {
    expect(
      conflictFor(
        { toggleMute: null, toggleDeafen: null, fullscreenShare: null },
        'toggleMute',
        'F8',
      ),
    ).toBeNull();
  });
});

describe('stored bindings', () => {
  const defaults = defaultBindings(false);

  it('gives anything missing its default', () => {
    expect(sanitizeBindings(undefined, false)).toEqual(defaults);
    expect(sanitizeBindings('junk', false)).toEqual(defaults);
    expect(sanitizeBindings({ toggleMute: 'F8' }, false)).toEqual({
      ...defaults,
      toggleMute: 'F8',
    });
  });

  it('keeps "not set" as a choice', () => {
    expect(sanitizeBindings({ toggleDeafen: null }, false).toggleDeafen).toBeNull();
  });

  it('replaces a value this version refuses, or cannot read', () => {
    expect(sanitizeBindings({ toggleMute: 'Ctrl+KeyC' }, false).toggleMute).toBe(
      defaults.toggleMute,
    );
    expect(sanitizeBindings({ toggleMute: 42 }, false).toggleMute).toBe(defaults.toggleMute);
    expect(sanitizeBindings({ toggleMute: '<script>' }, false).toggleMute).toBe(
      defaults.toggleMute,
    );
  });

  it('never lets one key fire two actions', () => {
    const clean = sanitizeBindings({ toggleMute: 'F8', toggleDeafen: 'F8' }, false);
    expect(clean.toggleMute).toBe('F8');
    expect(clean.toggleDeafen).toBeNull();
  });

  it('never lets a default collide with what someone chose', () => {
    const clean = sanitizeBindings({ toggleMute: defaults.toggleDeafen }, false);
    expect(clean.toggleMute).toBe(defaults.toggleDeafen);
    expect(clean.toggleDeafen).toBeNull();
  });
});

describe('Ctrl and Cmd standing in for each other', () => {
  const bindings = {
    toggleMute: 'Cmd+Shift+KeyM',
    toggleDeafen: 'Ctrl+Shift+KeyD',
    fullscreenShare: 'Cmd+KeyJ',
  };

  it('finds the action by its exact keys', () => {
    expect(actionFor(bindings, 'Cmd+Shift+KeyM')).toBe('toggleMute');
    expect(actionFor(bindings, 'Cmd+KeyJ')).toBe('fullscreenShare');
    expect(actionFor(bindings, 'F8')).toBeNull();
  });

  it('accepts either key when a second modifier is held', () => {
    expect(actionFor(bindings, 'Ctrl+Shift+KeyM')).toBe('toggleMute');
    expect(actionFor(bindings, 'Cmd+Shift+KeyD')).toBe('toggleDeafen');
  });

  it('prefers an action bound to the exact keys', () => {
    const both = { ...bindings, toggleDeafen: 'Ctrl+Shift+KeyM' };
    expect(actionFor(both, 'Ctrl+Shift+KeyM')).toBe('toggleDeafen');
    expect(actionFor(both, 'Cmd+Shift+KeyM')).toBe('toggleMute');
  });

  it('does not swap with one modifier, where Ctrl edits text on a Mac', () => {
    expect(actionFor(bindings, 'Ctrl+KeyJ')).toBeNull();
  });
});

describe('while typing in a field', () => {
  it('lets Ctrl and Cmd through', () => {
    expect(firesWhileTyping(press('KeyM', { ctrlKey: true }), false, false)).toBe(true);
    expect(firesWhileTyping(press('KeyM', { metaKey: true }), false, true)).toBe(true);
  });

  it('leaves letters and capitals as text', () => {
    expect(firesWhileTyping(press('KeyM'), false, false)).toBe(false);
    expect(firesWhileTyping(press('KeyM', { shiftKey: true, key: 'M' }), false, false)).toBe(false);
  });

  it('lets a function key through, which types nothing', () => {
    expect(firesWhileTyping(press('F8'), false, false)).toBe(true);
    expect(firesWhileTyping(press('F8', { shiftKey: true }), false, false)).toBe(true);
  });

  it('treats Alt by platform: it types characters on a Mac and nothing elsewhere', () => {
    expect(firesWhileTyping(press('KeyM', { altKey: true, key: 'µ' }), false, true)).toBe(false);
    expect(firesWhileTyping(press('KeyM', { altKey: true }), false, false)).toBe(true);
  });

  it('leaves AltGr as text, which reports itself as Ctrl+Alt on European layouts', () => {
    const atSign = press('KeyQ', { ctrlKey: true, altKey: true, key: '@' });
    expect(firesWhileTyping(atSign, true, false)).toBe(false);
  });

  it('leaves the first step of a composed character as text', () => {
    expect(firesWhileTyping(press('Quote', { key: 'Dead' }), false, false)).toBe(false);
    expect(firesWhileTyping(press('KeyA', { key: 'Process' }), false, false)).toBe(false);
  });
});
