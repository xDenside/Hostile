import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { resetDatabase, startTestApi, type TestApi } from '../support/harness.js';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi({ livekit: true });
  await resetDatabase(api.ctx);
});

afterAll(async () => {
  await api?.stop();
});

test('a burst of health checks costs one database probe and no LiveKit call', async () => {
  await api.ctx.voice.reconcile();
  const reachable = api.ctx.voice.status().mediaReachable;
  const query = vi.spyOn(api.ctx.db, '$queryRaw');
  const ping = vi.spyOn(api.ctx.voice, 'ping');
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => api.http().get('/api/health')),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: reachable ? 'ok' : 'degraded',
        database: 'ok',
        media: reachable ? 'ok' : 'unreachable',
      });
      expect(typeof res.body.uptimeSec).toBe('number');
    }
    expect(query).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    ping.mockRestore();
  }
});
