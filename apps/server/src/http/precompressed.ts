import { readdirSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { RequestHandler } from 'express';

const ENCODINGS = [
  { encoding: 'br', extension: '.br' },
  { encoding: 'gzip', extension: '.gz' },
] as const;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HOUR = 'public, max-age=3600';

export function precompressedFiles(dir: string): RequestHandler {
  const available = new Map<string, Set<string>>();
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    for (const { extension } of ENCODINGS) {
      if (!entry.endsWith(extension)) continue;
      const path = `/${entry.slice(0, -extension.length).split(sep).join('/')}`;
      available.set(path, (available.get(path) ?? new Set()).add(extension));
    }
  }

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const copies = available.get(req.path);
    if (!copies) return next();

    res.vary('Accept-Encoding');
    const match = ENCODINGS.find(
      ({ encoding, extension }) =>
        copies.has(extension) && req.acceptsEncodings(encoding) === encoding,
    );
    if (!match) return next();

    res.setHeader('Content-Encoding', match.encoding);
    res.setHeader('Cache-Control', req.path.startsWith('/assets/') ? IMMUTABLE : HOUR);
    res.type(extname(req.path));
    res.sendFile(
      join(`.${req.path}`) + match.extension,
      { root: dir, cacheControl: false },
      (err?: Error & { code?: string }) => {
        if (!err || err.code === 'ECONNABORTED' || res.headersSent) return;
        res.removeHeader('Content-Encoding');
        res.removeHeader('Cache-Control');
        next(err);
      },
    );
  };
}
