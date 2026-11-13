import { describe, expect, it } from 'vitest';
import { tabTitle } from '../src/lib/tab-title';

describe('the tab title', () => {
  it('is the plain name when everything is read', () => {
    expect(tabTitle('Hostile', 0)).toBe('Hostile');
  });

  it('leads with how many channels have something new', () => {
    expect(tabTitle('Hostile', 1)).toBe('(1) Hostile');
    expect(tabTitle('Hostile', 12)).toBe('(12) Hostile');
  });

  it('stops counting at 99', () => {
    expect(tabTitle('Hostile', 250)).toBe('(99+) Hostile');
  });
});
