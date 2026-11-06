import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);
const pkg = require(resolve(root, 'package.json'));

const external = [...Object.keys(pkg.dependencies ?? {}), 'pino-pretty'].filter(
  (name) => name !== '@hostile/shared',
);

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

await build({
  ...common,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/main.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'src/cli/seed-dev.ts')],
  outdir: resolve(root, 'dist/cli'),
});

console.log('Server bundled to apps/server/dist (main.js, cli/seed-dev.js)');
