import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('../src/styles/tokens.scss', import.meta.url), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
  if (!match) throw new Error(`No solid color token --${name}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channel = (at: number) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const ALL_SURFACES = ['bg-sidebar', 'bg-main', 'bg-elevated', 'bg-overlay', 'bg-input'];
const FLAT_SURFACES = ['bg-sidebar', 'bg-main', 'bg-input'];
const SMALL_TEXT = 4.5;
const ICON = 3;

describe('text stays readable on the surfaces it sits on', () => {
  it.each(['text', 'text-2', 'text-muted', 'accent', 'warning', 'danger-text'])(
    '--%s reaches 4.5:1 everywhere',
    (name) => {
      for (const surface of ALL_SURFACES) {
        expect(contrast(token(name), token(surface)), `on --${surface}`).toBeGreaterThanOrEqual(
          SMALL_TEXT,
        );
      }
    },
  );

  it('--text-faint reaches 4.5:1 where it is text, and 3:1 where it is an icon', () => {
    for (const surface of FLAT_SURFACES) {
      expect(
        contrast(token('text-faint'), token(surface)),
        `on --${surface}`,
      ).toBeGreaterThanOrEqual(SMALL_TEXT);
    }
    for (const surface of ALL_SURFACES) {
      expect(
        contrast(token('text-faint'), token(surface)),
        `on --${surface}`,
      ).toBeGreaterThanOrEqual(ICON);
    }
  });

  it('dark text on the accent stays readable too', () => {
    expect(contrast(token('text-on-accent'), token('accent'))).toBeGreaterThanOrEqual(SMALL_TEXT);
  });
});

describe('the layers can be told apart', () => {
  it('steps visibly from the sidebar to content to cards', () => {
    const step = 1.1;
    expect(contrast(token('bg-main'), token('bg-sidebar'))).toBeGreaterThanOrEqual(step);
    expect(contrast(token('bg-elevated'), token('bg-main'))).toBeGreaterThanOrEqual(step);
  });
});
