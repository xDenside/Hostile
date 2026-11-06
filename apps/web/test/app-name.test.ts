import { BRAND, DESKTOP_ORIGIN } from '@hostile/shared';
import { describe, expect, it } from 'vitest';

describe('the name of the app', () => {
  it('is Hostile, in everything that holds it', () => {
    expect(BRAND).toEqual({
      displayName: 'Hostile',
      name: 'Hostile',
      slug: 'hostile',
      desktopScheme: 'hostile',
      desktopHost: 'hostile',
    });
    expect(DESKTOP_ORIGIN).toBe('hostile://hostile');
  });
});
