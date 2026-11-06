import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { precompressDir } from '../vite-precompress';

describe('precompressDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'precompress-'));
    mkdirSync(join(dir, 'assets'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes copies that decompress to exactly the original, in nested folders too', async () => {
    const original = Buffer.from('const greeting = "hello";\n'.repeat(500));
    const file = join(dir, 'assets', 'index-abc.js');
    writeFileSync(file, original);

    await precompressDir(dir);

    expect(brotliDecompressSync(readFileSync(`${file}.br`)).equals(original)).toBe(true);
    expect(gunzipSync(readFileSync(`${file}.gz`)).equals(original)).toBe(true);
    expect(readFileSync(`${file}.br`).length).toBeLessThan(original.length / 10);
  });

  it('leaves alone what is too small, already compressed, or a source map', async () => {
    const big = Buffer.from('x'.repeat(4096));
    writeFileSync(join(dir, 'small.js'), 'a');
    writeFileSync(join(dir, 'assets', 'font.woff2'), big);
    writeFileSync(join(dir, 'assets', 'index.js.map'), big);

    await precompressDir(dir);

    for (const name of ['small.js', 'assets/font.woff2', 'assets/index.js.map']) {
      expect(existsSync(join(dir, `${name}.br`)), name).toBe(false);
      expect(existsSync(join(dir, `${name}.gz`)), name).toBe(false);
    }
  });

  it('keeps no copy that came out larger than what it copies', async () => {
    const file = join(dir, 'noise.wasm');
    writeFileSync(file, randomBytes(2048));

    await precompressDir(dir);

    expect(existsSync(`${file}.gz`)).toBe(false);
  });
});
