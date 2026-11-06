import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

const IMPORT = /import\s+(\w+)\s+from\s+'([^']+\.module\.scss)'/g;

function classesIn(stylesheet: string): Set<string> {
  const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]!));
}

function usages(): { source: string; stylesheet: string; name: string; found: boolean }[] {
  const out: { source: string; stylesheet: string; name: string; found: boolean }[] = [];
  for (const source of filesIn(SRC).filter((file) => /\.tsx?$/.test(file))) {
    const code = readFileSync(source, 'utf8');
    const body = code.replace(/^import\s[^;]*;$/gm, '');
    for (const [, binding, path] of code.matchAll(IMPORT)) {
      const stylesheet = resolve(dirname(source), path!);
      const classes = classesIn(readFileSync(stylesheet, 'utf8'));
      const reference = new RegExp(`\\b${binding}\\.(\\w+)|\\b${binding}\\['([^']+)'\\]`, 'g');
      for (const match of body.matchAll(reference)) {
        const name = (match[1] ?? match[2])!;
        out.push({ source, stylesheet, name, found: classes.has(name) });
      }
    }
  }
  return out;
}

describe('CSS modules', () => {
  it('reads real usages, so that an empty result cannot pass for a clean one', () => {
    expect(usages().length).toBeGreaterThan(200);
  });

  it('has every class the components ask for', () => {
    const missing = usages()
      .filter((usage) => !usage.found)
      .map((usage) => `${usage.source.replace(SRC, 'src')}: ${usage.name}`);
    expect(missing).toEqual([]);
  });
});
