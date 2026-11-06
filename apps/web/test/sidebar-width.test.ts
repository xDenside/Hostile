import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, SIDEBAR_WIDTH } from '../src/stores/ui';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('the channel list width', () => {
  it('stays between its limits', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(99_999)).toBe(SIDEBAR_WIDTH.max);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it('leaves the chat room on a small window, and never goes under its minimum for it', () => {
    expect(clampSidebarWidth(500, 900)).toBe(340);
    expect(clampSidebarWidth(500, 720)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(500, 1920)).toBe(500);
  });

  it('survives a saved value that is not a usable number', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default);
  });

  it('agrees with the styles, which have the same numbers', () => {
    expect(read('../src/styles/tokens.scss')).toContain(
      `--sidebar-pref: ${SIDEBAR_WIDTH.default}px;`,
    );
    expect(read('../src/features/layout/layout.module.scss')).toContain(
      `clamp(${SIDEBAR_WIDTH.min}px, 100vw - 560px, var(--sidebar-pref))`,
    );
  });
});
