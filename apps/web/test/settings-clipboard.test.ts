import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../src/features/settings/SettingsPage';
import { useUi } from '../src/stores/ui';

function toastTexts(): string[] {
  return useUi.getState().toasts.map((t) => `${t.kind}: ${t.text}`);
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUi.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('confirms a successful copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } });
    await copyToClipboard('ROOM-CODE');
    expect(toastTexts()).toEqual(['success: Copied.']);
  });

  it('reports a rejected clipboard write instead of failing silently', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) },
    });
    await copyToClipboard('ROOM-CODE');
    expect(toastTexts()).toEqual([
      'error: Could not copy. Select the code above and copy it manually.',
    ]);
  });

  it('reports a missing clipboard API (no secure context) the same way', async () => {
    vi.stubGlobal('navigator', {});
    await copyToClipboard('ROOM-CODE');
    expect(toastTexts()).toEqual([
      'error: Could not copy. Select the code above and copy it manually.',
    ]);
  });
});
