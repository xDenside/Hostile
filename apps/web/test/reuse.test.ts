import { describe, expect, it } from 'vitest';
import { reuse } from '../src/lib/reuse';

describe('reuse', () => {
  it('hands back the old value when the new one says the same', () => {
    const prev = { a: [1, { b: 2 }], c: { d: null }, e: 'x' };
    expect(reuse(prev, structuredClone(prev))).toBe(prev);
  });

  it('keeps the parts that did not change and takes the ones that did', () => {
    const prev = { alice: { name: 'Alice' }, bob: { name: 'Bob' } };
    const next = reuse(prev, { alice: { name: 'Alice' }, bob: { name: 'Robert' } });
    expect(next).not.toBe(prev);
    expect(next.alice).toBe(prev.alice);
    expect(next.bob).toEqual({ name: 'Robert' });
  });

  it('notices keys and items that came or went', () => {
    const prev: Record<string, unknown> = { a: 1 };
    expect(reuse(prev, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined });
    expect(reuse(prev, {})).toEqual({});
    expect(reuse({ a: undefined }, { b: undefined })).toEqual({ b: undefined });
    expect(reuse([1, 2], [1])).toEqual([1]);
    expect(reuse([1], [1, 2])).toEqual([1, 2]);
  });

  it('does not mistake one shape for another', () => {
    expect(reuse([], {})).toEqual({});
    expect(reuse({}, [])).toEqual([]);
    expect(reuse(null, {})).toEqual({});
    expect(reuse({}, null)).toBeNull();
  });
});
