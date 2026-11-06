import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precompressedFiles } from '../../src/http/precompressed.js';

function get(
  port: number,
  path: string,
  acceptEncoding?: string,
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        path,
        method,
        headers: acceptEncoding === undefined ? {} : { 'Accept-Encoding': acceptEncoding },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('precompressedFiles', () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'precompressed-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc.js'), 'the plain file');
    writeFileSync(join(dir, 'assets', 'app-abc.js.br'), 'the brotli file');
    writeFileSync(join(dir, 'assets', 'app-abc.js.gz'), 'the gzip file');
    writeFileSync(join(dir, 'assets', 'only-gzip.wasm'), 'the plain file');
    writeFileSync(join(dir, 'assets', 'only-gzip.wasm.gz'), 'the gzip file');
    writeFileSync(join(dir, 'assets', 'never-compressed.js'), 'the plain file');
    writeFileSync(join(dir, 'icon.svg'), 'the plain file');
    writeFileSync(join(dir, 'icon.svg.br'), 'the brotli file');

    const app = express();
    app.use(precompressedFiles(dir));
    app.use(express.static(dir, { index: false }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers brotli, and keeps the type and long cache of the file it stands for', async () => {
    const res = await get(port, '/assets/app-abc.js', 'gzip, deflate, br, zstd');
    expect(res.status).toBe(200);
    expect(res.body).toBe('the brotli file');
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to gzip for a browser that does not take brotli', async () => {
    const res = await get(port, '/assets/app-abc.js', 'gzip');
    expect(res.body).toBe('the gzip file');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('honours a refusal', async () => {
    const res = await get(port, '/assets/app-abc.js', 'br;q=0, gzip');
    expect(res.body).toBe('the gzip file');
  });

  it('only offers what exists', async () => {
    const res = await get(port, '/assets/only-gzip.wasm', 'br, gzip');
    expect(res.body).toBe('the gzip file');
    expect(res.headers['content-type']).toBe('application/wasm');
  });

  it('sends the plain file to whoever takes no compression, and warns caches', async () => {
    for (const accept of [undefined, 'identity', 'zstd']) {
      const res = await get(port, '/assets/app-abc.js', accept);
      expect(res.body, String(accept)).toBe('the plain file');
      expect(res.headers['content-encoding'], String(accept)).toBeUndefined();
      expect(res.headers.vary, String(accept)).toBe('Accept-Encoding');
    }
  });

  it('leaves a file with no copies to the next handler', async () => {
    const res = await get(port, '/assets/never-compressed.js', 'br, gzip');
    expect(res.body).toBe('the plain file');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('caches a file outside assets for an hour, since its name can stay the same', async () => {
    const res = await get(port, '/icon.svg', 'br');
    expect(res.body).toBe('the brotli file');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('answers a HEAD without a body, and ignores other methods', async () => {
    const head = await get(port, '/assets/app-abc.js', 'br', 'HEAD');
    expect(head.headers['content-encoding']).toBe('br');
    expect(head.body).toBe('');
    const post = await get(port, '/assets/app-abc.js', 'br', 'POST');
    expect(post.status).toBe(404);
  });

  it('matches only exact paths from the list, so no request path reaches the disk', async () => {
    for (const path of [
      '/assets/../assets/app-abc.js',
      '/assets/%2e%2e/assets/app-abc.js',
      '/assets/APP-ABC.js',
      '/assets/app-abc.js/',
      '/app-abc.js',
    ]) {
      const res = await get(port, path, 'br');
      expect(res.headers['content-encoding'], path).toBeUndefined();
    }
  });
});
