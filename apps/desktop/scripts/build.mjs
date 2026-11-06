import { copyFile, cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '../..');
const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
const OUT_DIR = join(DESKTOP_DIR, 'dist');
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const withRenderer = !args.has('--no-renderer');
const proof = args.has('--proof');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env.HOSTILE_PROOF_BUILD': JSON.stringify(proof ? '1' : ''),
  },
};

const targets = [
  {
    entry: join(DESKTOP_DIR, 'src', 'main.ts'),
    outfile: join(OUT_DIR, 'main.cjs'),
    target: 'node24',
  },
  {
    entry: join(DESKTOP_DIR, 'src', 'preload.ts'),
    outfile: join(OUT_DIR, 'preload.cjs'),
    target: 'chrome152',
  },
  {
    entry: join(DESKTOP_DIR, 'src', 'bridge-preload.ts'),
    outfile: join(OUT_DIR, 'bridge-preload.cjs'),
    target: 'chrome152',
  },
];

const hostBundles = [
  ['server-entry.ts', 'server.mjs'],
  ['gateway-entry.ts', 'gateway.mjs'],
].map(([entry, out]) => ({
  entryPoints: [join(SERVER_DIR, 'src', 'host', entry)],
  outfile: join(OUT_DIR, 'host', out),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node24'],
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'warning',
  external: ['pino-pretty'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
}));

async function copyHostFiles() {
  const hostDir = join(OUT_DIR, 'host');
  await mkdir(hostDir, { recursive: true });
  const pglite = join(SERVER_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist');
  for (const file of ['pglite.wasm', 'pglite.data', 'initdb.wasm']) {
    await copyFile(join(pglite, file), join(hostDir, file));
  }
  await rm(join(hostDir, 'prisma'), { recursive: true, force: true });
  await cp(join(SERVER_DIR, 'prisma', 'migrations'), join(hostDir, 'prisma', 'migrations'), {
    recursive: true,
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyRenderer() {
  if (!(await exists(join(WEB_DIST, 'index.html')))) {
    console.error(
      `\napps/web/dist is missing or incomplete (${WEB_DIST}).\n` +
        'Build the web client first:  pnpm --filter @hostile/web build\n' +
        'Or skip the copy for development:  node scripts/build.mjs --no-renderer\n',
    );
    process.exit(1);
  }
  const rendererDir = join(OUT_DIR, 'renderer');
  await rm(rendererDir, { recursive: true, force: true });
  await mkdir(rendererDir, { recursive: true });
  await cp(WEB_DIST, rendererDir, { recursive: true });
  console.log(`renderer copied to ${rendererDir}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (withRenderer) await copyRenderer();

  await copyHostFiles();

  const options = [
    ...targets.map(({ entry, outfile, target }) => ({
      ...shared,
      entryPoints: [entry],
      outfile,
      target: [target],
    })),
    ...hostBundles,
  ];

  if (!watch) {
    await Promise.all(options.map((option) => esbuild.build(option)));
    console.log('main.cjs, the preloads and the host bundles written to dist/');
    return;
  }

  const contexts = await Promise.all(options.map((option) => esbuild.context(option)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('watching src/ for changes (restart Electron to pick up main-process changes)');
  process.on('SIGINT', () => {
    void Promise.all(contexts.map((context) => context.dispose())).then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
