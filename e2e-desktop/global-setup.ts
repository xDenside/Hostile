import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { startLocalRendezvous } from '../e2e/local-rendezvous';
import { GUEST_DIR, GUEST_PORT, RELAY_PORT } from './host-harness';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export default async function globalSetup() {
  const relay = await startLocalRendezvous(RELAY_PORT);
  const site = createServer((request, response) => {
    const path = normalize(new URL(request.url ?? '/', 'http://x').pathname);
    const file = join(GUEST_DIR, path === '/' ? 'index.html' : path);
    const found =
      existsSync(file) && statSync(file).isFile() ? file : join(GUEST_DIR, 'index.html');
    response.setHeader('Content-Type', TYPES[extname(found)] ?? 'application/octet-stream');
    createReadStream(found).pipe(response);
  });
  await new Promise<void>((resolve) => site.listen(GUEST_PORT, '127.0.0.1', resolve));
  return async () => {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
    await relay.stop();
  };
}
