import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, randomSecret } from './lib/env.mjs';
import { log } from './lib/proc.mjs';

const argv = process.argv.slice(2);
const ROUNDS = Number(argv.find((a) => a.startsWith('--rounds='))?.split('=')[1] ?? 10);
const useElectron = argv.includes('--electron');

const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const API_PORT = Number(process.env.DURABILITY_API_PORT ?? 4391);
const BASE = `http://127.0.0.1:${API_PORT}`;
const WRITERS = 6;
const CHANNEL = 'general';

const parent = mkdtempSync(join(tmpdir(), 'hostile-durability-'));
const DATA_DIR = join(parent, 'data_test');
const SESSION_SECRET = randomSecret(32);

function runtime() {
  if (!useElectron) return { command: process.execPath, env: {} };
  const desktopRequire = createRequire(join(REPO_ROOT, 'apps', 'desktop', 'package.json'));
  return { command: desktopRequire('electron'), env: { ELECTRON_RUN_AS_NODE: '1' } };
}
const { command, env: runtimeEnv } = runtime();
const OWNER_SECRET = 'durability-test-owner-secret-of-enough-length';

function runtimeName() {
  const { stdout } = spawnSync(
    command,
    [
      '-p',
      "(process.versions.electron ? 'Electron ' + process.versions.electron + ', ' : '') + 'Node ' + process.versions.node",
    ],
    { env: { ...process.env, ...runtimeEnv }, encoding: 'utf8' },
  );
  return stdout.trim();
}

const serverEnv = (dataDir = DATA_DIR) => ({
  ...process.env,
  ...runtimeEnv,
  HOSTILE_ENV: 'test',
  HOSTILE_ENV_FILE: join(parent, 'no-such-file'),
  API_HOST: '127.0.0.1',
  API_PORT: String(API_PORT),
  PUBLIC_APP_URL: 'http://localhost:5391',
  DATA_DIR: dataDir,
  SESSION_SECRET,
  RATE_LIMIT_DISABLED: 'true',
  OWNER_SECRET,
  LOG_LEVEL: 'error',
  LOG_PRETTY: 'false',
});

function startServer(dataDir) {
  const child = spawn(command, ['dist/main.js'], {
    cwd: SERVER_DIR,
    env: serverEnv(dataDir),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.exitedPromise = new Promise((resolve) => child.once('exit', resolve));
  return child;
}

const kill9 = async (child) => {
  child.kill('SIGKILL');
  await child.exitedPromise;
};

async function waitHealthy(child, startedAt) {
  let exit = null;
  child.exitedPromise.then((code) => (exit = { code }));
  const deadline = startedAt + 60_000;
  while (performance.now() < deadline) {
    if (exit) throw new Error(`The server exited with ${exit.code} instead of opening.`);
    const up = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.status === 200)
      .catch(() => false);
    if (up) return Math.round(performance.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The server did not answer within 60 s.');
}

async function api(path, { token, body, method } = {}) {
  const res = await fetch(BASE + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function ownerSession() {
  const res = await api('/api/auth/owner', { body: { secret: OWNER_SECRET, client: 'desktop' } });
  if (res.status !== 200) throw new Error(`Owner session failed: ${res.status} ${res.text}`);
  return res.json.accessToken;
}

async function readAll(token, channelId) {
  const pages = [];
  let before;
  for (;;) {
    const query = new URLSearchParams({ limit: '100', ...(before ? { before } : {}) });
    const res = await api(`/api/channels/${channelId}/messages?${query}`, { token });
    if (res.status !== 200) throw new Error(`Read failed: ${res.status} ${res.text}`);
    const { messages, hasOlder } = res.json;
    pages.unshift(messages);
    if (!hasOlder || !messages.length) return pages.flat();
    before = String(messages[0].seq);
  }
}

function checkAgainst(acked, messages) {
  const problems = [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const ack of acked) {
    const found = byId.get(ack.id);
    if (!found) problems.push(`acknowledged message ${ack.id} (seq ${ack.seq}) is gone`);
    else if (found.content !== ack.content || found.seq !== ack.seq)
      problems.push(`acknowledged message ${ack.id} changed`);
  }
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].seq !== messages[i - 1].seq + 1)
      problems.push(`seq jumps from ${messages[i - 1].seq} to ${messages[i].seq}`);
  }
  return problems;
}

async function writer(token, channelId, acked, state) {
  while (!state.stop) {
    const content = `message ${randomUUID()} ${'x'.repeat(Math.floor(Math.random() * 400))}`;
    try {
      const res = await api(`/api/channels/${channelId}/messages`, {
        token,
        body: { content, clientNonce: randomUUID() },
      });
      if (res.status >= 200 && res.status < 300) {
        const message = res.json.message ?? res.json;
        acked.push({ id: message.id, seq: message.seq, content });
      } else if (!state.stop) {
        state.refused.push(`${res.status} ${res.text.slice(0, 200)}`);
      }
    } catch {
      return;
    }
  }
}

async function indexCheck(dataDir) {
  const require = createRequire(join(SERVER_DIR, 'package.json'));
  const entry = require.resolve('@electric-sql/pglite');
  const { PGlite } = await import(pathToFileURL(entry).href);
  const { amcheck } = await import(
    pathToFileURL(join(dirname(entry), 'contrib', 'amcheck.js')).href
  );
  const pg = new PGlite(join(dataDir, 'db'), { extensions: { amcheck } });
  await pg.waitReady;
  await pg.exec('CREATE EXTENSION IF NOT EXISTS amcheck');
  const { rows: indexes } = await pg.query(`
    SELECT c.oid::regclass::text AS name FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am a ON a.oid = c.relam
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.amname = 'btree' AND n.nspname = 'public'`);
  for (const { name } of indexes) {
    await pg.query(`SELECT bt_index_check($1::regclass, true)`, [name]);
  }
  const { rows } = await pg.query(`SELECT count(*)::int AS n FROM messages`);
  await pg.close();
  return { indexes: indexes.length, messages: rows[0].n };
}

async function main() {
  const report = [];
  log.info(`Building the server${useElectron ? ', to run under Electron' : ''}…`);
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
  });
  if (built.status !== 0) throw new Error('The server did not build.');

  for (const delay of [50, 200, 400, 700, 1000]) {
    const dir = join(parent, `first_run_${delay}_test`);
    const child = startServer(dir);
    await new Promise((resolve) => setTimeout(resolve, delay));
    await kill9(child);
    const reopening = performance.now();
    const again = startServer(dir);
    const ms = await waitHealthy(again, reopening);
    await kill9(again);
    log.ok(`First run killed after ${delay} ms: the next start opened in ${ms} ms`);
  }

  const seed = spawnSync(command, ['dist/cli/seed-dev.js'], {
    cwd: SERVER_DIR,
    env: serverEnv(),
    encoding: 'utf8',
  });
  if (seed.status !== 0) throw new Error(`The seed failed: ${seed.stdout} ${seed.stderr}`);

  let started = performance.now();
  let server = startServer();
  const firstOpen = await waitHealthy(server, started);
  log.info(`Started on the seeded database in ${firstOpen} ms`);
  const token = await ownerSession();
  const boot = await api('/api/bootstrap', { token });
  if (boot.status !== 200) throw new Error(`Bootstrap failed: ${boot.status}`);
  const channelId = boot.json.channels.find((c) => c.name === CHANNEL).id;

  const allAcked = [];
  let failures = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const acked = [];
    const state = { stop: false, refused: [] };
    const writers = Array.from({ length: WRITERS }, () => writer(token, channelId, acked, state));
    const delay = 1000 + Math.random() * 3000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    await kill9(server);
    state.stop = true;
    await Promise.all(writers);
    allAcked.push(...acked);

    started = performance.now();
    server = startServer();
    const recovery = await waitHealthy(server, started);
    const messages = await readAll(token, channelId);
    const problems = checkAgainst(allAcked, messages);
    const refused = state.refused.length;
    if (problems.length || refused) failures += 1;
    report.push({ round, acked: acked.length, total: messages.length, recovery, refused });
    const line = `Round ${round}/${ROUNDS}: killed after ${Math.round(delay)} ms, ${acked.length} acknowledged this round, ${allAcked.length} in all, ${messages.length} present, reopened in ${recovery} ms`;
    if (problems.length) {
      log.fail(line);
      for (const problem of problems.slice(0, 10)) console.log(`    ${problem}`);
    } else if (refused) {
      log.fail(`${line}; ${refused} send(s) refused: ${state.refused[0]}`);
    } else {
      log.ok(line);
    }
  }

  const after = await api(`/api/channels/${channelId}/messages`, {
    token,
    body: { content: 'after the last kill', clientNonce: randomUUID() },
  });
  if (after.status < 200 || after.status >= 300) {
    failures += 1;
    log.fail(`A send after the last kill failed: ${after.status} ${after.text}`);
  }
  server.kill('SIGTERM');
  await server.exitedPromise;
  const check = await indexCheck(DATA_DIR);
  log.ok(`amcheck passed on ${check.indexes} indexes; ${check.messages} messages in the table`);

  const recoveries = report.map((r) => r.recovery).sort((a, b) => a - b);
  console.log(
    `\n${runtimeName()}: ${ROUNDS - failures}/${ROUNDS} rounds clean. ` +
      `${allAcked.length} acknowledged messages checked after each kill. ` +
      `Reopen after a kill: median ${recoveries[Math.floor(recoveries.length / 2)]} ms, worst ${recoveries.at(-1)} ms.`,
  );
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  log.fail(err?.stack ?? String(err));
} finally {
  rmSync(parent, { recursive: true, force: true });
}
process.exit(code);
