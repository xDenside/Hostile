import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { protocol, type Session } from 'electron';
import { BRAND } from '@hostile/shared';
import { bridgeContentSecurityPolicy, contentSecurityPolicy } from './csp.js';
import { log, messageOf } from './log.js';
import type { Runtime } from './runtime.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BRAND.desktopScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
        allowServiceWorkers: true,
      },
    },
  ]);
}

export function registerAppProtocol(runtime: Runtime): void {
  protocol.handle(
    BRAND.desktopScheme,
    handlerFor(runtime, () => contentSecurityPolicy(runtime.cspInputs())),
  );
}

export function registerBridgeProtocol(
  runtime: Runtime,
  session: Session,
  gatewayPort: () => number,
  testRelays: string[],
): void {
  session.protocol.handle(
    BRAND.desktopScheme,
    handlerFor(runtime, () => bridgeContentSecurityPolicy(gatewayPort(), testRelays)),
  );
}

function handlerFor(runtime: Runtime, policy: () => string) {
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return respond(policy, 400, 'text/plain; charset=utf-8', Buffer.from('Bad request'));
    }
    if (url.host !== BRAND.desktopHost) {
      return respond(policy, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'));
    }

    const requestedPath = safeRelativePath(url.pathname);
    if (requestedPath === null) {
      log.warn(`blocked renderer request outside the bundle: ${url.pathname}`);
      return respond(policy, 403, 'text/plain; charset=utf-8', Buffer.from('Forbidden'));
    }

    const file = await resolveFile(runtime.rendererDir, requestedPath);
    if (!file) return respond(policy, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'));

    try {
      const body = await readFile(file);
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return respond(policy, 200, type, body, extname(file).toLowerCase() === '.html');
    } catch (err) {
      log.error(`could not read ${file}: ${messageOf(err)}`);
      return respond(policy, 500, 'text/plain; charset=utf-8', Buffer.from('Internal error'));
    }
  };
}

function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const trimmed = decoded.replace(/^\/+/, '');
  if (trimmed === '') return 'index.html';
  const candidate = join('/', trimmed);
  const rel = relative('/', candidate);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

async function resolveFile(rendererDir: string, requestedPath: string): Promise<string | null> {
  const target = join(rendererDir, requestedPath);
  const rel = relative(rendererDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const found = await isFile(target);
  if (found) return target;
  if (extname(requestedPath) !== '') return null;
  const index = join(rendererDir, 'index.html');
  return (await isFile(index)) ? index : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function respond(
  policy: () => string,
  status: number,
  contentType: string,
  body: Buffer,
  noStore = false,
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Content-Security-Policy': policy(),
      'X-Content-Type-Options': 'nosniff',
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
    },
  });
}
