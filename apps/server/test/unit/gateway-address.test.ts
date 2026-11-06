import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addressFromGatewayOnly, GATEWAY_TOKEN_HEADER } from '../../src/http/gateway-address.js';

const TOKEN = 't'.repeat(43);

function hostedApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(addressFromGatewayOnly(TOKEN));
  app.get('/', (req, res) =>
    res.json({ ip: req.ip, ips: req.ips, seenToken: req.headers[GATEWAY_TOKEN_HEADER] ?? null }),
  );
  return app;
}

const LOOPBACK = /^(::ffff:)?127\.0\.0\.1$|^::1$/;

describe('who may state an address in a hosted room', () => {
  it('believes the address the gateway states, and passes its token no further', async () => {
    const res = await request(hostedApp())
      .get('/')
      .set(GATEWAY_TOKEN_HEADER, TOKEN)
      .set('X-Forwarded-For', 'fd68::1');
    expect(res.body.ip).toBe('fd68::1');
    expect(res.body.seenToken).toBeNull();
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'x'.repeat(43)],
    ['a token of another length', 't'],
    ['an empty token', ''],
  ])('counts a program on this PC with %s as the PC itself', async (_name, token) => {
    const call = request(hostedApp()).get('/').set('X-Forwarded-For', '203.0.113.9');
    if (token !== null) void call.set(GATEWAY_TOKEN_HEADER, token);
    const res = await call;
    expect(res.body.ip).toMatch(LOOPBACK);
    expect(res.body.ips).toEqual([]);
    expect(res.body.seenToken).toBeNull();
  });

  it('counts a caller that sends the header twice, which Node joins, as the PC itself', async () => {
    const res = await request(hostedApp())
      .get('/')
      .set(GATEWAY_TOKEN_HEADER, `${TOKEN}, ${TOKEN}`)
      .set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).toMatch(LOOPBACK);
  });
});
