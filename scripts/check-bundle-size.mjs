import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { REPO_ROOT } from './lib/env.mjs';
import { log } from './lib/proc.mjs';

const KB = 1024;
const BUDGET = {
  initialJs: 240 * KB,
  initialCss: 21 * KB,
  totalJs: 1950 * KB,
};

const dist = join(REPO_ROOT, 'apps', 'web', 'dist');
const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  log.fail('apps/web/dist/index.html not found. Run `pnpm --filter @hostile/web run build`.');
  process.exit(1);
}

const gzipped = (file) => gzipSync(readFileSync(file)).length;
const assetsIn = (html, pattern) =>
  [...html.matchAll(pattern)].map((match) => join(dist, match[1].replace(/^\//, '')));

const html = readFileSync(indexPath, 'utf8');
const scripts = assetsIn(html, /<script[^>]+src="([^"]+\.js)"/g);
const preloads = assetsIn(html, /<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g);
const styles = assetsIn(html, /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g);
const assets = join(dist, 'assets');
const allJs = readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => join(assets, name));

const total = (files) => [...new Set(files)].reduce((sum, file) => sum + gzipped(file), 0);
const measured = {
  initialJs: total([...scripts, ...preloads]),
  initialCss: total(styles),
  totalJs: total(allJs),
};

let over = false;
for (const [name, bytes] of Object.entries(measured)) {
  const limit = BUDGET[name];
  const line = `${name}: ${(bytes / KB).toFixed(1)} KB gzip of ${(limit / KB).toFixed(0)} KB`;
  if (bytes > limit) {
    over = true;
    log.fail(`${line}: over by ${((bytes - limit) / KB).toFixed(1)} KB`);
  } else {
    log.ok(line);
  }
}

if (over) {
  console.error(
    '\nFind what grew with `pnpm --filter @hostile/web exec vite build`, which lists every ' +
      'file.\nMove it behind a dynamic import if it can wait, or raise the budget in this script.',
  );
  process.exit(1);
}
