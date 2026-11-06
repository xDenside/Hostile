import { describe, expect, it, vi } from 'vitest';
import { SharedReads } from '../../src/lib/shared-reads.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SharedReads', () => {
  it('gives everyone asking for one key the same read', async () => {
    const gate = deferred<Buffer>();
    const read = vi.fn(() => gate.promise);
    const reads = new SharedReads(read, 100, 2);
    const asked = [reads.get('a'), reads.get('a'), reads.get('a')];
    await settle();
    gate.resolve(Buffer.from('x'));
    const answers = await Promise.all(asked);
    expect(read).toHaveBeenCalledTimes(1);
    expect(answers.every((answer) => answer?.toString() === 'x')).toBe(true);
  });

  it('answers from memory the next time', async () => {
    const read = vi.fn(async () => Buffer.from('x'));
    const reads = new SharedReads(read, 100, 2);
    const first = await reads.get('a');
    expect(await reads.get('a')).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('runs only so many reads at once, and every one of them in the end', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const started: string[] = [];
    const reads = new SharedReads(
      (key) => {
        started.push(key);
        const gate = deferred<Buffer>();
        gates.set(key, gate);
        return gate.promise;
      },
      100,
      2,
    );
    const asked = ['a', 'b', 'c', 'd'].map((key) => reads.get(key));
    await settle();
    expect(started).toEqual(['a', 'b']);
    gates.get('a')!.resolve(Buffer.from('a'));
    await settle();
    expect(started).toEqual(['a', 'b', 'c']);
    const failed = expect(asked[1]).rejects.toThrow('the database went away');
    gates.get('b')!.reject(new Error('the database went away'));
    await settle();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    gates.get('c')!.resolve(Buffer.from('c'));
    gates.get('d')!.resolve(Buffer.from('d'));
    await failed;
    expect((await asked[3])?.toString()).toBe('d');
  });

  it('forgets a failure, and does not remember something that was not there', async () => {
    const read = vi
      .fn<(key: string) => Promise<Buffer | null>>()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('now it is'));
    const reads = new SharedReads(read, 100, 2);
    await expect(reads.get('a')).rejects.toThrow('no');
    expect(await reads.get('a')).toBeNull();
    expect((await reads.get('a'))?.toString()).toBe('now it is');
  });

  it('lets go of what was used longest ago to stay inside the bound', async () => {
    const read = vi.fn(async (key: string) => Buffer.alloc(40, key));
    const reads = new SharedReads(read, 100, 2);
    await reads.get('a');
    await reads.get('b');
    await reads.get('a');
    await reads.get('c');
    expect(read).toHaveBeenCalledTimes(3);
    await reads.get('a');
    await reads.get('c');
    expect(read).toHaveBeenCalledTimes(3);
    await reads.get('b');
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('never holds a value bigger than the bound', async () => {
    const read = vi.fn(async () => Buffer.alloc(101));
    const reads = new SharedReads(read, 100, 2);
    await reads.get('a');
    await reads.get('a');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
