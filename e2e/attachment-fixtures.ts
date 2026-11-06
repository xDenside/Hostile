import { crc32, deflateSync } from 'node:zlib';
import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { signIn, type Person } from './helpers';

export { buildFtyp, REAL_VIDEOS } from '../apps/server/test/support/videos';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function png(width: number, height: number, seed = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    for (let x = 0; x < width; x++) {
      const at = start + 1 + x * 3;
      const u = x / width;
      const v = y / height;
      rows[at] = 60 + 150 * Math.abs(Math.sin(seed + u * 2.4));
      rows[at + 1] = 60 + 130 * Math.abs(Math.sin(seed * 2.1 + v * 2.2 + u));
      rows[at + 2] = 70 + 150 * Math.abs(Math.cos(seed * 0.7 + (u + v) * 1.8));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const pngFile = (name: string, width = 640, height = 360, seed = 1) => ({
  name,
  mimeType: 'image/png',
  buffer: png(width, height, seed),
});

export async function user(
  browser: Browser,
  credentials: Person,
  options: BrowserContextOptions = {},
) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, credentials);
  return { context, page };
}

export async function expectAtBottom(page: Page) {
  await expect
    .poll(() =>
      page
        .getByRole('log')
        .evaluate((el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight)),
    )
    .toBeLessThan(2);
}
