import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return path.endsWith('.scss') ? [path] : [];
  });
}

describe('user-select', () => {
  it.each(stylesheets(SRC).map((path) => [path.slice(SRC.length + 1), path]))(
    '%s carries the prefix Safari needs',
    (_name, path) => {
      const lines = readFileSync(path!, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const value = /^\s*user-select: (\w+);/.exec(line)?.[1];
        if (value) expect(lines[i - 1]?.trim()).toBe(`-webkit-user-select: ${value};`);
      });
    },
  );

  it('fields stay typable, since iOS will not type into one that is not selectable', () => {
    const css = readFileSync(join(SRC, 'styles/global.scss'), 'utf8');
    expect(css).toMatch(
      /input,\s*textarea[^{]*\{[^}]*-webkit-user-select: text;[^}]*user-select: text;/,
    );
  });
});
