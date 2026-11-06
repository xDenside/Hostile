import { describe, expect, it } from 'vitest';
import { SerialQueue, suppressorStillWanted } from '../src/features/voice/switching';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SerialQueue', () => {
  it('runs tasks one at a time, in the order they were asked for', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = deferred();
    const running = queue.run(async () => {
      order.push('first in');
      await first.promise;
      order.push('first out');
    });
    const second = queue.run(async () => {
      order.push('second in');
      await Promise.resolve();
      order.push('second out');
    });
    await Promise.resolve();
    expect(order).toEqual(['first in']);
    first.resolve();
    await Promise.all([running, second]);
    expect(order).toEqual(['first in', 'first out', 'second in', 'second out']);
  });

  it('makes the running task stale as soon as another is queued behind it', async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    const seen: boolean[] = [];
    const first = queue.run(async (token) => {
      seen.push(queue.isNewest(token));
      await gate.promise;
      seen.push(queue.isNewest(token));
    });
    await Promise.resolve();
    const second = queue.run((token) => {
      seen.push(queue.isNewest(token));
      return Promise.resolve();
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual([true, false, true]);
  });

  it('makes a task that was superseded before it even started stale from the start', async () => {
    const queue = new SerialQueue();
    const seen: boolean[] = [];
    const tasks = [
      queue.run((token) => {
        seen.push(queue.isNewest(token));
        return Promise.resolve();
      }),
      queue.run((token) => {
        seen.push(queue.isNewest(token));
        return Promise.resolve();
      }),
    ];
    await Promise.all(tasks);
    expect(seen).toEqual([false, true]);
  });

  it('keeps going, and reports the failure, when a task throws', async () => {
    const queue = new SerialQueue();
    const failure = queue.run(() => Promise.reject(new Error('device busy')));
    const after = queue.run(() => Promise.resolve('ran anyway'));
    await expect(failure).rejects.toThrow('device busy');
    await expect(after).resolves.toBe('ran anyway');
  });

  it('is busy from the first task until the queue drains, and says so once each way', async () => {
    const changes: boolean[] = [];
    const queue = new SerialQueue((busy) => changes.push(busy));
    expect(queue.busy).toBe(false);
    const gate = deferred();
    const first = queue.run(() => gate.promise);
    const second = queue.run(() => Promise.resolve());
    expect(queue.busy).toBe(true);
    expect(changes).toEqual([true]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(queue.busy).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('is not left busy by a task that failed', async () => {
    const changes: boolean[] = [];
    const queue = new SerialQueue((busy) => changes.push(busy));
    await expect(queue.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(queue.busy).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});

describe('suppressorStillWanted', () => {
  const room = { room: true };
  const track = { track: true };
  const attempt = {
    token: 7,
    newestToken: 7,
    room,
    roomNow: room,
    track,
    trackNow: track,
    suppressor: 'rnnoise',
    suppressorNow: 'rnnoise',
  };

  it('attaches a suppressor that is still the newest thing asked for', () => {
    expect(suppressorStillWanted(attempt)).toBe(true);
  });

  it('refuses one whose switch was superseded while it was being built', () => {
    expect(suppressorStillWanted({ ...attempt, newestToken: 8 })).toBe(false);
  });

  it('refuses one whose call was left while it was being built', () => {
    expect(suppressorStillWanted({ ...attempt, roomNow: null })).toBe(false);
    expect(suppressorStillWanted({ ...attempt, room: null, roomNow: null })).toBe(false);
    expect(suppressorStillWanted({ ...attempt, roomNow: { room: 'another call' } })).toBe(false);
  });

  it('refuses one whose microphone was replaced while it was being built', () => {
    expect(suppressorStillWanted({ ...attempt, trackNow: null })).toBe(false);
    expect(suppressorStillWanted({ ...attempt, trackNow: { track: 'republished' } })).toBe(false);
  });

  it('refuses one the settings no longer ask for', () => {
    expect(suppressorStillWanted({ ...attempt, suppressorNow: null })).toBe(false);
    expect(suppressorStillWanted({ ...attempt, suppressorNow: 'fastenhancer' })).toBe(false);
  });
});
