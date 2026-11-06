import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS } from '@hostile/shared';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(scss|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

function colorsOn(line: string): { text: string; channels: number[] }[] {
  const found: { text: string; channels: number[] }[] = [];
  for (const [text, hex] of line.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    const full = hex!.length === 3 ? [...hex!].map((c) => c + c).join('') : hex!;
    found.push({
      text,
      channels: [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)),
    });
  }
  for (const [text, r, g, b] of line.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) {
    found.push({ text, channels: [Number(r), Number(g), Number(b)] });
  }
  return found;
}

const isGrey = ([r, g, b]: number[]) => r === g && g === b;

describe('the interface is greys, plus one red', () => {
  it('has no other color written anywhere in its source', () => {
    const offenders: string[] = [];
    const logo = join(WEB, 'public', 'icon.svg');
    for (const file of [...sourceFiles(SRC), join(WEB, 'index.html'), logo]) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/^\s*--danger(-text|-soft)?:/.test(line)) return;
          for (const { text, channels } of colorsOn(line)) {
            if (!isGrey(channels)) offenders.push(`${file}:${index + 1} ${text}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('gives every new account a grey avatar', () => {
    for (const color of AVATAR_COLORS) {
      expect(isGrey(colorsOn(color)[0]!.channels), color).toBe(true);
    }
  });
});

describe('the icons the page names', () => {
  it('exist, at an address a browser will not answer from an old copy', () => {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)];
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const [, href] of hrefs) {
      const [path, query] = href!.split('?');
      expect(statSync(join(WEB, 'public', path!)).size, href).toBeGreaterThan(0);
      expect(query, href).toMatch(/^v=\d+$/);
    }
  });
});
