import { afterEach, describe, expect, it } from 'vitest';
import config from '../vite.config';

type Made = { build: { rollupOptions: { input: Record<string, string> } } };

const built = () => {
  const make = config as unknown as (env: { mode: string; command: string }) => Made;
  return Object.keys(make({ mode: 'production', command: 'build' }).build.rollupOptions.input);
};

describe('what each build ships', () => {
  const before = process.env.HOSTILE_GUEST;
  afterEach(() => {
    if (before === undefined) delete process.env.HOSTILE_GUEST;
    else process.env.HOSTILE_GUEST = before;
  });

  it('keeps the bridge page out of the guest site', () => {
    process.env.HOSTILE_GUEST = '1';
    expect(built()).toEqual(['main']);
  });

  it('keeps it in the build the app copies', () => {
    delete process.env.HOSTILE_GUEST;
    expect(built()).toEqual(['main', 'bridge']);
  });
});
