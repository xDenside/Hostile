import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { REPO_ROOT, TOOLS_DIR, loadRepoEnv } from './lib/env.mjs';
import {
  LIVEKIT_VERSION as DEV_VERSION,
  findLivekitBinary,
  projectLocalBinary,
} from './lib/livekit.mjs';
import { color, log, runSync } from './lib/proc.mjs';

const ASSETS = {
  'linux-amd64': 'tar.gz',
  'linux-arm64': 'tar.gz',
  'linux-armv7': 'tar.gz',
  'windows-amd64': 'zip',
  'windows-arm64': 'zip',
};

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'livekit-manifest.json'), 'utf8'),
);
const wantedOs = option('os') ?? hostOs();
const wantedArch = option('arch') ?? hostArch();
const entry =
  manifest[
    `${wantedOs === 'windows' ? 'win32' : wantedOs}-${wantedArch === 'amd64' ? 'x64' : wantedArch}`
  ];
const LIVEKIT_VERSION = entry?.version ?? DEV_VERSION;
const RELEASE_BASE = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}`;

function hostOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

function hostArch() {
  return { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch] ?? process.arch;
}

function extractFromTar(buf, wanted) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size =
      parseInt(header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, ''), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if ((type === '0' || type === '\0') && basename(name) === wanted) {
      return buf.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function extractFromZip(buf, wanted) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const entries = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  if (cd === 0xffffffff || entries === 0xffff) throw new Error('zip64 archives are not supported');

  for (let i = 0; i < entries; i += 1) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(cd + 10);
    const expectedCrc = buf.readUInt32LE(cd + 16);
    const compressedSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOffset = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    cd += 46 + nameLen + extraLen + commentLen;
    if (basename(name) !== wanted) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('corrupt zip local file header');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip compression method ${method}`);
    if (crc32(data) !== expectedCrc) throw new Error('zip entry failed its CRC32 check');
    return data;
  }
  return null;
}

async function fetchBuffer(url, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks = [];
  let received = 0;
  let lastShown = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (process.stdout.isTTY && total && received - lastShown > total / 20) {
      lastShown = received;
      process.stdout.write(`\r    ${label}: ${Math.round((received / total) * 100)}%   `);
    }
  }
  if (process.stdout.isTTY && total) process.stdout.write('\r\x1b[K');
  return Buffer.concat(chunks);
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

async function main() {
  const os = option('os') ?? hostOs();
  const arch = option('arch') ?? hostArch();
  const target = `${os}-${arch}`;
  const crossPlatform = os !== hostOs() || arch !== hostArch();

  console.log(
    `\n${color(1, `LiveKit server ${LIVEKIT_VERSION}`)}  ${color(90, `target ${target}`)}\n`,
  );

  if (os === 'darwin') {
    log.warn(
      'The LiveKit project publishes no macOS release archive, so there is nothing to download.',
    );
    const found = findLivekitBinary(loadRepoEnv());
    if (found && !found.missing) {
      log.ok(
        `livekit-server ${found.version ?? '?'} is already installed (${found.source}): ${found.path}`,
      );
      if (found.version && found.version !== LIVEKIT_VERSION) {
        log.warn(
          `This repository is tested against ${LIVEKIT_VERSION}; run \`brew upgrade livekit\` to match it.`,
        );
      }
      console.log('\nNothing was installed and nothing needs to be.\n');
      return 0;
    }
    console.log('Install it with Homebrew instead:');
    console.log(`    ${color(36, 'brew install livekit')}`);
    console.log('\nThen `pnpm dev` picks it up from PATH. Alternatively build it from source');
    console.log('(https://github.com/livekit/livekit) and set LIVEKIT_BIN in .env to the result.');
    console.log(`\nTo fetch a Linux or Windows build from here anyway (for another machine):`);
    console.log('    pnpm livekit:install -- --os=linux --arch=arm64\n');
    log.fail('Nothing was installed.');
    return 1;
  }

  const ext = ASSETS[target];
  if (!ext) {
    log.fail(`No LiveKit ${LIVEKIT_VERSION} release asset for ${target}.`);
    log.info(`Available: ${Object.keys(ASSETS).join(', ')}`);
    return 1;
  }

  if (!entry) {
    log.fail(`The manifest names no media server for ${target}, so none is fetched.`);
    process.exit(1);
  }
  const asset = `livekit_${LIVEKIT_VERSION}_${os}_${arch}.${ext}`;
  const exeName = os === 'windows' ? 'livekit-server.exe' : 'livekit-server';
  const dest = crossPlatform
    ? join(TOOLS_DIR, 'livekit', LIVEKIT_VERSION, target, exeName)
    : projectLocalBinary();

  if (existsSync(dest) && !flag('force')) {
    log.ok(`Already installed: ${dest}`);
    log.info('Re-download with `pnpm livekit:install -- --force`.');
    return 0;
  }

  log.info(`Downloading ${asset}…`);
  const checksumText = await fetchBuffer(`${RELEASE_BASE}/checksums.txt`, 'checksums.txt');
  const archive = await fetchBuffer(`${RELEASE_BASE}/${asset}`, asset);

  const expected = parseChecksums(checksumText.toString('utf8')).get(asset);
  if (!expected) {
    log.fail(
      `checksums.txt of release v${LIVEKIT_VERSION} has no entry for ${asset}; refusing to unpack it.`,
    );
    return 1;
  }
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    log.fail(
      'sha256 mismatch - the download is corrupt or has been tampered with. Nothing was written.',
    );
    console.log(`    expected ${expected}`);
    console.log(`    actual   ${actual}`);
    return 1;
  }
  log.ok(
    `sha256 verified against the release checksums.txt (${(archive.length / 1_048_576).toFixed(1)} MiB)`,
  );

  let binary;
  try {
    binary =
      ext === 'zip'
        ? extractFromZip(archive, exeName)
        : extractFromTar(gunzipSync(archive), exeName);
  } catch (err) {
    log.fail(`Could not unpack ${asset}: ${err.message}`);
    return 1;
  }
  if (!binary?.length) {
    log.fail(`${asset} does not contain ${exeName}; the release layout must have changed.`);
    log.info(
      `Unpack it by hand and set LIVEKIT_BIN in .env to the ${exeName} inside ${RELEASE_BASE}/${asset}.`,
    );
    return 1;
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, binary);
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  log.ok(`Installed ${exeName} (${(binary.length / 1_048_576).toFixed(1)} MiB) at:`);
  console.log(`    ${dest}`);

  if (!crossPlatform) {
    const check = runSync(dest, ['--version']);
    const reported = /(\d+\.\d+\.\d+)/.exec(check.stdout + check.stderr)?.[1];
    if (reported) log.ok(`It runs and reports version ${reported}`);
    else
      log.warn('The binary was written but did not report a version; run it by hand to see why.');
    console.log(`
${color(1, 'Next')}
  pnpm dev                              finds this copy automatically (no configuration needed)
  pnpm check                       confirms which livekit-server will be used

To use a different build instead, set it explicitly in .env:
  LIVEKIT_BIN=${dest}
`);
  } else {
    console.log(`
This is a ${target} build, so it was kept out of the path \`pnpm dev\` looks in.
Copy it to the target machine and point .env there at it:
  LIVEKIT_BIN=<path on that machine>
`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.fail(err?.stack ?? String(err));
    process.exit(1);
  });
