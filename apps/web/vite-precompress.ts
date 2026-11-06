import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const COMPRESSIBLE = /\.(js|mjs|css|wasm|svg|json)$/;
const MIN_BYTES = 1024;

export async function precompressDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && COMPRESSIBLE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

  await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file);
      if (bytes.length < MIN_BYTES) return;
      const twins: [string, Buffer][] = [
        [
          '.br',
          await brotli(bytes, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        ],
        ['.gz', await gz(bytes, { level: constants.Z_BEST_COMPRESSION })],
      ];
      for (const [extension, compressed] of twins) {
        if (compressed.length < bytes.length) await writeFile(file + extension, compressed);
      }
    }),
  );
}

export function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hostile:precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      await precompressDir(outDir);
    },
  };
}
