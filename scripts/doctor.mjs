import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENV_FILE, REPO_ROOT, loadRepoEnv, readEnvFile } from './lib/env.mjs';
import { LIVEKIT_VERSION, findLivekitBinary, projectLocalBinary } from './lib/livekit.mjs';
import { isTcpPortFree, isUdpPortFree } from './lib/net.mjs';
import { color, log, resolveBin, runSync, which } from './lib/proc.mjs';

const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');

const tally = { pass: 0, warn: 0, fail: 0 };

function section(title) {
  console.log(`\n${color(1, title)}`);
}

function hint(text) {
  console.log(`    ${color(90, '→')} ${text}`);
}

function pass(msg) {
  tally.pass += 1;
  log.ok(msg);
}

function warn(msg, ...hints) {
  tally.warn += 1;
  log.warn(msg);
  hints.forEach(hint);
}

function fail(msg, ...hints) {
  tally.fail += 1;
  log.fail(msg);
  hints.forEach(hint);
}

function runTool(cmd, args) {
  return runSync(cmd, args, { shell: process.platform === 'win32' });
}

function parseVersion(text) {
  const m = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) return null;
  for (const token of String(range).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?(?:\.\d+)?)$/.exec(token);
    if (!m) return null;
    const bound = parseVersion(m[2]);
    if (!bound) return null;
    const c = cmpVersion(v, bound);
    const op = m[1] ?? '=';
    const ok =
      (op === '>=' && c >= 0) ||
      (op === '<=' && c <= 0) ||
      (op === '>' && c > 0) ||
      (op === '<' && c < 0) ||
      (op === '=' && c === 0);
    if (!ok) return false;
  }
  return true;
}

function rootPackageJson() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
}

function checkToolchain(pkg) {
  section('Toolchain');

  const range = pkg.engines?.node ?? '';
  const ok = satisfiesRange(process.versions.node, range);
  if (ok === null) {
    warn(`Node ${process.versions.node} (could not interpret engines.node "${range}")`);
  } else if (ok) {
    pass(`Node ${process.versions.node} matches engines.node "${range}"`);
  } else {
    fail(
      `Node ${process.versions.node} does not match engines.node "${range}"`,
      'Install Node 24 LTS (.nvmrc pins it: `nvm use`, `fnm use`, or download from nodejs.org).',
    );
  }

  const declared = pkg.packageManager ?? '(not set)';
  const wantedPnpm = parseVersion(declared.replace(/^pnpm@/, ''));
  const agent = /pnpm\/(\d+\.\d+\.\d+)/.exec(process.env.npm_config_user_agent ?? '');
  let pnpmVersion = agent?.[1] ?? null;
  let source = 'npm_config_user_agent';
  if (!pnpmVersion) {
    if (!which('pnpm')) {
      fail(
        'pnpm not found on PATH',
        'Install it with `npm install -g pnpm@11` or `corepack enable pnpm`.',
      );
    } else {
      const res = runTool('pnpm', ['--version']);
      pnpmVersion = res.code === 0 ? res.stdout.trim() : null;
      source = 'pnpm --version';
      if (!pnpmVersion)
        fail(
          `pnpm is on PATH but \`pnpm --version\` failed: ${res.stderr.trim() || res.error?.message}`,
        );
    }
  }
  if (pnpmVersion) {
    const v = parseVersion(pnpmVersion);
    if (v && wantedPnpm && v[0] === wantedPnpm[0]) {
      pass(`pnpm ${pnpmVersion} (${source}); packageManager declares ${declared}`);
    } else if (v && wantedPnpm) {
      fail(
        `pnpm ${pnpmVersion} does not match packageManager ${declared} (major ${wantedPnpm[0]} expected)`,
        'Run `corepack enable pnpm` so the version in package.json is used automatically.',
      );
    } else {
      warn(`pnpm ${pnpmVersion}; packageManager is ${declared}`);
    }
  }
}

const REQUIRED_ENV_KEYS = [
  'HOSTILE_ENV',
  'WEB_PORT',
  'API_PORT',
  'LIVEKIT_PORT',
  'LIVEKIT_RTC_UDP_PORT',
  'PUBLIC_APP_URL',
  'LIVEKIT_INTERNAL_URL',
  'LIVEKIT_PUBLIC_URL',
  'SESSION_SECRET',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
];

function urlPort(value) {
  try {
    const u = new URL(value);
    if (u.port) return u.port;
    return (
      {
        'https:': '443',
        'wss:': '443',
        'http:': '80',
        'ws:': '80',
      }[u.protocol] ?? null
    );
  } catch {
    return null;
  }
}

function checkEnvFile(env) {
  section('Configuration (.env)');
  if (!existsSync(ENV_FILE)) {
    fail(
      `${ENV_FILE} not found`,
      'Run `pnpm setup:local`: it creates .env and generates development secrets.',
    );
    return false;
  }
  const raw = readEnvFile() ?? {};
  pass(`${ENV_FILE} exists (${Object.keys(raw).length} variables)`);

  if (process.platform !== 'win32') {
    const mode = statSync(ENV_FILE).mode & 0o777;
    if (mode & 0o077) {
      warn(
        `.env is mode ${mode.toString(8)}: other users on this computer can read the secrets in it`,
        `Run \`pnpm setup:local\` (it tightens the file without changing values) or: chmod 600 ${ENV_FILE}`,
      );
    } else {
      pass('.env is readable by its owner only');
    }
  }

  const placeholders = Object.entries(raw)
    .filter(([, v]) => v === '__generate__' || v === '__generate_key__')
    .map(([k]) => k);
  if (placeholders.length) {
    fail(
      `Unreplaced placeholder value(s): ${placeholders.join(', ')}`,
      'Run `pnpm setup:local` again; it fills placeholders and leaves existing values alone.',
    );
  } else {
    pass('No __generate__ placeholders left');
  }

  const missing = REQUIRED_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length)
    fail(`Empty or missing variable(s): ${missing.join(', ')}`, 'Run `pnpm setup:local`.');
  else pass(`All ${REQUIRED_ENV_KEYS.length} required variables are set (values not shown)`);

  if (env.HOSTILE_ENV !== 'development') {
    warn(`HOSTILE_ENV=${env.HOSTILE_ENV}; the local scripts expect "development"`);
  }

  const pairs = [
    ['LIVEKIT_INTERNAL_URL', urlPort(env.LIVEKIT_INTERNAL_URL), 'LIVEKIT_PORT', env.LIVEKIT_PORT],
    ['LIVEKIT_PUBLIC_URL', urlPort(env.LIVEKIT_PUBLIC_URL), 'LIVEKIT_PORT', env.LIVEKIT_PORT],
    ['PUBLIC_APP_URL', urlPort(env.PUBLIC_APP_URL), 'WEB_PORT', env.WEB_PORT],
  ];
  let mismatch = false;
  for (const [urlKey, port, portKey, expected] of pairs) {
    if (!env[urlKey]) continue;
    if (port === null) {
      fail(`${urlKey} is not a valid URL`, `Expected a URL whose port is ${portKey}=${expected}.`);
      mismatch = true;
    } else if (String(port) !== String(expected)) {
      fail(
        `${urlKey} uses port ${port} but ${portKey}=${expected}`,
        'Fix one of the two in .env so they agree.',
      );
      mismatch = true;
    }
  }
  if (!mismatch)
    pass('Port values agree between the *_PORT variables and the URLs that embed them');

  return true;
}

async function identifyTcpListener(port, kind) {
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(1500) });
      return { status: res.status, body: (await res.text()).slice(0, 4000) };
    } catch {
      return null;
    }
  };
  if (kind === 'api') {
    const res = await get('/api/health');
    if (res && /"status"\s*:/.test(res.body) && /"media"\s*:/.test(res.body))
      return "this project's API (pnpm dev)";
  }
  if (kind === 'web') {
    const res = await get('/');
    if (res && res.body.includes('/@vite/client'))
      return "this project's Vite dev server (pnpm dev)";
  }
  if (kind === 'livekit') {
    const root = await get('/');
    const validate = await get('/rtc/validate');
    if (root?.body.trim() === 'OK' && validate?.status === 401) return 'livekit-server (pnpm dev)';
  }
  const any = await get('/');
  if (any) return 'an unrecognised HTTP server';
  return 'an unknown process (not HTTP)';
}

async function checkPorts(env) {
  section('Ports');
  const host = '127.0.0.1';
  let livekitIsOurs = false;

  const tcpChecks = [
    ['WEB_PORT', env.WEB_PORT, 'web'],
    ['API_PORT', env.API_PORT, 'api'],
    ['LIVEKIT_PORT', env.LIVEKIT_PORT, 'livekit'],
  ];
  for (const [key, port, kind] of tcpChecks) {
    if (!port) continue;
    if (await isTcpPortFree(port, host)) {
      pass(`${key} ${port}/tcp is free`);
      continue;
    }
    const who = await identifyTcpListener(port, kind);
    const ours = who.startsWith('this project') || who.startsWith('livekit-server');
    if (kind === 'livekit' && who.startsWith('livekit-server')) livekitIsOurs = true;
    if (ours) pass(`${key} ${port}/tcp is in use by ${who}`);
    else
      fail(
        `${key} ${port}/tcp is in use by ${who}`,
        `Stop that process or change ${key} in .env (then run \`pnpm check\` again).`,
      );
  }

  const udpPort = env.LIVEKIT_RTC_UDP_PORT;
  if (udpPort) {
    if (await isUdpPortFree(udpPort, host)) {
      pass(`LIVEKIT_RTC_UDP_PORT ${udpPort}/udp is free`);
    } else if (livekitIsOurs) {
      pass(
        `LIVEKIT_RTC_UDP_PORT ${udpPort}/udp is in use by the livekit-server started by pnpm dev`,
      );
    } else {
      fail(
        `LIVEKIT_RTC_UDP_PORT ${udpPort}/udp is in use and no livekit-server of this project answers on ${env.LIVEKIT_PORT}`,
        'Voice media needs this UDP port. Stop the other process or change LIVEKIT_RTC_UDP_PORT in .env.',
      );
    }
  }
}

function livekitInstallHint() {
  if (process.platform === 'darwin')
    return 'brew install livekit   (no official macOS release archive exists)';
  return 'pnpm livekit:install   (downloads the pinned official release into .tools/)';
}

function checkLivekit(env) {
  section('LiveKit server');
  const lk = findLivekitBinary(env);
  if (!lk) {
    warn(
      'livekit-server not found (voice and screen sharing will be unavailable; chat still works)',
      livekitInstallHint(),
      'Or set LIVEKIT_BIN in .env to an existing livekit-server executable.',
    );
    return { ok: false };
  }
  if (lk.missing) {
    fail(
      `LIVEKIT_BIN points at ${lk.path}, which does not exist`,
      'Correct LIVEKIT_BIN in .env, or clear it to fall back to .tools/ and PATH.',
    );
    return { ok: false };
  }
  if (!lk.version) {
    warn(`livekit-server at ${lk.path} (${lk.source}) did not report a version`);
    return { ok: true };
  }
  if (lk.version === LIVEKIT_VERSION) {
    pass(`livekit-server ${lk.version} from ${lk.source}: ${lk.path}`);
  } else {
    warn(
      `livekit-server ${lk.version} from ${lk.source}; this repository is tested against ${LIVEKIT_VERSION}`,
      `A project-local ${LIVEKIT_VERSION} can be installed with \`pnpm livekit:install\` (${projectLocalBinary()}).`,
    );
  }
  return { ok: true };
}

function checkElectron() {
  section('Desktop client');
  const dist = join(DESKTOP_DIR, 'node_modules', 'electron', 'dist');
  const exe =
    {
      darwin: join(dist, 'Electron.app'),
      win32: join(dist, 'electron.exe'),
    }[process.platform] ?? join(dist, 'electron');
  if (!existsSync(DESKTOP_DIR)) {
    warn('apps/desktop is missing; the desktop client is not part of this checkout');
    return;
  }
  if (!existsSync(dist)) {
    warn(
      'Electron binary not downloaded (apps/desktop/node_modules/electron/dist is missing)',
      "Run `pnpm install` at the repository root. pnpm only runs electron's postinstall for packages listed in allowBuilds of pnpm-workspace.yaml.",
      'Behind a proxy or mirror, set ELECTRON_MIRROR before installing.',
    );
    return;
  }
  if (!existsSync(exe)) {
    fail(
      `Electron dist exists but ${exe} is missing (partial or interrupted download)`,
      'Delete apps/desktop/node_modules/electron and run `pnpm install` again.',
    );
    return;
  }
  const versionFile = join(dist, 'version');
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '?';
  pass(`Electron ${version} binary present for ${process.platform}`);
}

function playwrightBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}

function checkPlaywright() {
  section('End-to-end test browsers');
  let cli;
  try {
    cli = resolveBin('@playwright/test', 'playwright', REPO_ROOT);
  } catch {
    warn('@playwright/test is not installed', 'Run `pnpm install` at the repository root.');
    return;
  }
  const res = runSync(process.execPath, [cli, '--version']);
  if (res.code !== 0) {
    warn(`\`playwright --version\` failed: ${res.stderr.trim() || res.error?.message}`);
    return;
  }
  pass(`Playwright CLI: ${res.stdout.trim()}`);

  const dir = playwrightBrowsersDir();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const chromium = entries.filter((e) => e.startsWith('chromium-'));
  if (chromium.length) {
    pass(`Chromium build present in ${dir} (${chromium.join(', ')})`);
  } else {
    warn(
      `No chromium build in ${dir}; e2e tests cannot run`,
      'Install it with `npx playwright install chromium` (add `--with-deps` on Linux).',
    );
  }
}

function checkDatabase(env) {
  section('Database');
  const dataDir = resolve(env.DATA_DIR || join(REPO_ROOT, '.local', 'data'));
  const migrations = readdirSync(join(SERVER_DIR, 'prisma', 'migrations'), {
    withFileTypes: true,
  }).filter((e) => e.isDirectory()).length;
  if (!existsSync(join(dataDir, 'db', 'PG_VERSION'))) {
    pass(`${dataDir} has no database yet; the server creates it on its first start`);
    return;
  }
  pass(
    `Database in ${dataDir}. The server applies whatever is new of the ${migrations} committed migrations when it starts`,
  );
}

function platformNotes() {
  section('Platform notes');
  if (process.platform === 'darwin') {
    log.info(
      'macOS: while running unpackaged, microphone and screen-recording prompts are attributed to the',
    );
    console.log(
      '    terminal application that started `pnpm dev`, not to the app. Grant them to that terminal',
    );
    console.log(
      '    (System Settings → Privacy & Security → Microphone / Screen & System Audio Recording).',
    );
    console.log('    The packaged app asks for its own permissions.');
  } else if (process.platform === 'win32') {
    log.info(
      'Windows: the first run may raise a Windows Defender Firewall prompt for Node.js or Electron.',
    );
    console.log(
      '    Everything here listens on the loopback interface only, so "Private networks" is enough;',
    );
    console.log('    declining the prompt does not break a same-machine setup.');
  } else {
    log.info(`Platform ${process.platform}: no extra permission steps are known for this setup.`);
  }
}

async function main() {
  console.log(`\n${color(1, 'Hostile doctor')}  ${color(90, REPO_ROOT)}`);

  const pkg = rootPackageJson();
  checkToolchain(pkg);

  const env = loadRepoEnv();
  const failuresBeforeEnv = tally.fail;
  const envOk = checkEnvFile(env);
  const envBroken = !envOk || tally.fail > failuresBeforeEnv;
  await checkPorts(env);
  const livekit = checkLivekit(env);
  checkElectron();
  checkPlaywright();
  checkDatabase(env);
  platformNotes();

  section('Summary');
  const parts = [`${tally.pass} ok`, `${tally.warn} warning(s)`, `${tally.fail} problem(s)`];
  console.log(`  ${parts.join(', ')}`);

  let next = null;
  if (envBroken) next = 'pnpm setup:local';
  else if (!livekit.ok) next = livekitInstallHint();
  else if (tally.fail === 0) next = 'pnpm dev';
  if (next) console.log(`  Next: ${color(36, next)}`);

  if (tally.fail > 0) {
    console.log('');
    log.fail('Something needs fixing before the stack will run correctly.');
    process.exit(1);
  }
  console.log('');
  log.ok(tally.warn ? 'Usable, with the warnings above.' : 'Everything checks out.');
}

main().catch((err) => {
  log.fail(err?.stack ?? String(err));
  process.exit(1);
});
