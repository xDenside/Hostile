import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const build = resolve(here, '../build');
const svg = readFileSync(join(repo, 'apps/web/public/icon.svg'), 'utf8');

const CANVAS = 1024;
const BODY = 824;
const MARGIN = (CANVAS - BODY) / 2;
const RADIUS = 185;

const CORNER_START = [1.528665, 0];
const CORNER_CURVES = [
  [1.08849296, 0, 0.86840694, 0, 0.63149379, 0.07491139],
  [0.37282383, 0.16905956, 0.16905956, 0.37282383, 0.07491139, 0.63149379],
  [0, 0.86840694, 0, 1.08849296, 0, 1.528665],
];

function bodyPath() {
  const near = MARGIN;
  const far = MARGIN + BODY;
  const corners = [
    (a, b) => [far - a * RADIUS, near + b * RADIUS],
    (a, b) => [far - b * RADIUS, far - a * RADIUS],
    (a, b) => [near + a * RADIUS, far - b * RADIUS],
    (a, b) => [near + b * RADIUS, near + a * RADIUS],
  ];
  const at = ([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`;
  const parts = [];
  corners.forEach((map, index) => {
    parts.push(`${index === 0 ? 'M' : 'L'}${at(map(...CORNER_START))}`);
    for (const [a1, b1, a2, b2, a3, b3] of CORNER_CURVES) {
      parts.push(`C${at(map(a1, b1))} ${at(map(a2, b2))} ${at(map(a3, b3))}`);
    }
  });
  return `${parts.join(' ')} Z`;
}

function onTheGrid() {
  const mark = /<g [\s\S]*<\/g>/.exec(svg)?.[0];
  if (!mark) throw new Error('apps/web/public/icon.svg has no <g> holding the mark.');
  const fill = /<rect [^>]*fill="([^"]+)"/.exec(svg)?.[1];
  if (!fill) throw new Error('apps/web/public/icon.svg has no <rect> with a fill for the body.');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">
    <path d="${bodyPath()}" fill="${fill}" />
    <g transform="translate(${MARGIN} ${MARGIN}) scale(${BODY / CANVAS})">${mark}</g>
  </svg>`;
}

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const render = async (size, source = svg) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  return page.screenshot({ omitBackground: true });
};

const scratch = mkdtempSync(join(tmpdir(), 'hostile-icon-'));
const iconset = join(scratch, 'icon.iconset');
execFileSync('mkdir', ['-p', iconset]);
const grid = onTheGrid();
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${size}x${size}.png`), await render(size, grid));
  writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), await render(size * 2, grid));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')]);
writeFileSync(join(build, 'icon-mac.png'), await render(1024, grid));
writeFileSync(join(build, 'icon.png'), await render(1024));

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of sizes) pngs.push(await render(size));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
});
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...pngs]));
await browser.close();
rmSync(scratch, { recursive: true, force: true });
console.log('Wrote icon.icns and icon-mac.png on the grid, and icon.png and icon.ico full-bleed');
