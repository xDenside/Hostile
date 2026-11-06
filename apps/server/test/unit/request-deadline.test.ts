import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discardRequestBody,
  enforceRequestDeadlines,
  REQUEST_DEADLINE_MS,
  setRequestDeadline,
  touchRequestDeadline,
} from '../../src/http/request-deadline.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function listen(handler: RequestListener, deadlineMs = 150): Promise<number> {
  const server = createServer({ connectionsCheckingInterval: 25, headersTimeout: 200 }, handler);
  servers.push(server);
  enforceRequestDeadlines(server, deadlineMs);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function dial(port: number) {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  const seen = { text: '' };
  socket.on('data', (chunk) => (seen.text += chunk.toString('latin1')));
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return { socket, seen, closed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const POST = 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n';

describe('a request that dribbles in', () => {
  it('gets the 408 Node itself would send, and is cut off at the deadline', async () => {
    let bodyEnded = false;
    const port = await listen((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        bodyEnded = true;
        res.end('ok');
      });
    });
    const { socket, seen, closed } = dial(port);
    const startedAt = Date.now();
    socket.write(POST);
    const dripping = setInterval(() => socket.write('x'), 20);
    await closed;
    clearInterval(dripping);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(seen.text).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\nConnection: close\r\n\r\n/);
    expect(bodyEnded).toBe(false);
  });

  it('is left alone when it finishes in time', async () => {
    const port = await listen((req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    const { socket, seen } = dial(port);
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi');
    await sleep(300);
    expect(seen.text).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(socket.destroyed).toBe(false);
  });

  it('does not touch a slow response to a request that has fully arrived', async () => {
    const port = await listen((_req, res) => {
      res.write('start');
      setTimeout(() => res.end('finish'), 300);
    });
    const { socket, seen } = dial(port);
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await sleep(450);
    expect(seen.text).toContain('finish');
    expect(socket.destroyed).toBe(false);
  });
});

describe('slow headers', () => {
  it('are still cut off by Node, with its own timeout off', async () => {
    const port = await listen(() => {
      throw new Error('there is no request to handle yet');
    });
    const { socket, seen, closed } = dial(port);
    socket.write('POST / HTTP/1.1\r\nHost: x\r\n');
    const dripping = setInterval(() => socket.write('X-Slow: 1\r\n'), 20);
    await closed;
    clearInterval(dripping);
    expect(seen.text).toMatch(/^HTTP\/1\.1 408 Request Timeout/);
  });
});

describe('a route that takes the time it needs', () => {
  it('can give one request longer than the rest, while bytes keep coming', async () => {
    let received = 0;
    const port = await listen((req, res) => {
      setRequestDeadline(req, 200);
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        touchRequestDeadline(req);
      });
      req.on('end', () => res.end('whole'));
    });
    const { socket, seen } = dial(port);
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\n');
    for (let i = 0; i < 20; i++) {
      socket.write('x');
      await sleep(50);
    }
    await sleep(50);
    expect(received).toBe(20);
    expect(seen.text).toContain('whole');
  });

  it('still cuts off the same request when the bytes stop', async () => {
    const port = await listen((req) => {
      setRequestDeadline(req, 100);
      req.on('data', () => touchRequestDeadline(req));
    });
    const { socket, closed } = dial(port);
    socket.write(`${POST}abc`);
    const startedAt = Date.now();
    await closed;
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('a refused request', () => {
  it('has the answer read, and the rest of the body discarded in time', async () => {
    const port = await listen((req, res) => {
      discardRequestBody(req);
      res.statusCode = 413;
      res.end('too big');
    });
    const { socket, seen } = dial(port);
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\n\r\n');
    await sleep(20);
    socket.write('abcdef');
    await sleep(100);
    expect(seen.text).toMatch(/^HTTP\/1\.1 413/);
    expect(socket.destroyed).toBe(false);
  });

  it('keeps its deadline after the answer has gone out', async () => {
    const port = await listen((req, res) => {
      setRequestDeadline(req, 100);
      req.resume();
      res.statusCode = 401;
      res.end('no');
    });
    const { socket, seen, closed } = dial(port);
    socket.write(POST);
    const dripping = setInterval(() => socket.write('x'), 20);
    const startedAt = Date.now();
    await closed;
    clearInterval(dripping);
    expect(seen.text).toMatch(/^HTTP\/1\.1 401/);
    expect(seen.text).not.toContain('408');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('keeps its deadline even when the route never reads the body at all', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 401;
      res.end('no');
    }, 100);
    const { socket, seen, closed } = dial(port);
    socket.write(POST);
    const dripping = setInterval(() => socket.write('x'), 20);
    await closed;
    clearInterval(dripping);
    expect(seen.text).toMatch(/^HTTP\/1\.1 401/);
  });
});

it('keeps the five minutes Node would have given everything else', () => {
  expect(REQUEST_DEADLINE_MS).toBe(5 * 60 * 1000);
});
