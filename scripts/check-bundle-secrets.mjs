import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ENV_FILE, REPO_ROOT, readEnvFile } from './lib/env.mjs';
import { color, log } from './lib/proc.mjs';

const requireBuild = process.argv.includes('--require-build');

const TARGETS = [
  {
    label: 'web client',
    dir: join(REPO_ROOT, 'apps', 'web', 'dist'),
    build: 'pnpm --filter @hostile/web run build',
  },
  {
    label: 'desktop main/preload',
    dir: join(REPO_ROOT, 'apps', 'desktop', 'dist'),
    build: 'pnpm --filter @hostile/desktop run build',
    optional: true,
    serverCode: join(REPO_ROOT, 'apps', 'desktop', 'dist', 'host') + sep,
  },
];

const SECRET_VARS = ['SESSION_SECRET', 'LIVEKIT_API_SECRET'];

const PATTERNS = [
  {
    name: 'PEM private key block',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    describe: (m) => m[0],
  },
  {
    name: 'PEM block',
    re: /-----BEGIN (?!.*PRIVATE KEY)[A-Z0-9 ]+-----/g,
    describe: (m) => m[0],
  },
  {
    name: 'server-only environment variable name',
    re: /LIVEKIT_API_SECRET|SESSION_SECRET/g,
    describe: (m) => m[0],
    clientOnly: true,
  },
];

const SKIP_FILE = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|wav|webm|br|gz)$/i;
const MAX_BYTES = 64 * 1024 * 1024;

function encodings(value) {
  const buf = Buffer.from(value, 'utf8');
  const variants = new Map([
    ['plain', value],
    ['base64', buf.toString('base64')],
    ['base64url', buf.toString('base64url')],
    ['hex', buf.toString('hex')],
    ['url-encoded', encodeURIComponent(value)],
    ['json-escaped', JSON.stringify(value).slice(1, -1)],
  ]);
  const out = [];
  for (const [kind, text] of variants) {
    if (text.length < 12) continue;
    if (out.some((v) => v.text === text)) continue;
    out.push({ kind, text });
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function scanFile(file, needles, isServerCode) {
  const findings = [];
  const size = statSync(file).size;
  if (size > MAX_BYTES) {
    return { findings, skipped: `larger than ${MAX_BYTES / 1_048_576} MiB` };
  }
  const buf = readFileSync(file);
  const text = buf.toString('latin1');

  const seen = new Set();
  const add = (offset, group, what) => {
    const key = `${offset}|${group}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, offset, line: lineOf(text, offset), what });
  };

  for (const needle of needles) {
    let at = text.indexOf(needle.text);
    while (at !== -1) {
      add(at, needle.variable, `value of ${needle.variable} (${needle.kind} encoding)`);
      at = text.indexOf(needle.text, at + 1);
    }
  }
  for (const pattern of PATTERNS) {
    if (pattern.clientOnly && isServerCode) continue;
    pattern.re.lastIndex = 0;
    let m;
    while ((m = pattern.re.exec(text)) !== null) {
      add(m.index, pattern.name, `${pattern.name}: ${pattern.describe(m)}`);
      if (m[0].length === 0) pattern.re.lastIndex += 1;
    }
  }
  return { findings };
}

function main() {
  console.log(`\n${color(1, 'Build output secret scan')}\n`);

  const env = readEnvFile();
  const needles = [];
  if (!env) {
    log.warn(
      `${ENV_FILE} not found: only the generic patterns are checked, not the real secret values.`,
    );
  } else {
    const known = [];
    for (const variable of SECRET_VARS) {
      const value = env[variable];
      if (!value || value === '__generate__' || value === '__generate_key__') continue;
      known.push(variable);
      for (const enc of encodings(value)) needles.push({ variable, ...enc });
    }
    if (known.length)
      log.info(`Comparing against the current values of: ${known.join(', ')} (values not shown)`);
    else
      log.warn(
        '.env has no usable values for the checked variables; only generic patterns are checked.',
      );
  }

  let scanned = 0;
  const findings = [];
  const missing = [];
  for (const target of TARGETS) {
    if (!existsSync(target.dir)) {
      missing.push(target);
      continue;
    }
    const files = walk(target.dir).filter((f) => !SKIP_FILE.test(f));
    for (const file of files) {
      const res = scanFile(
        file,
        needles,
        Boolean(target.serverCode && file.startsWith(target.serverCode)),
      );
      scanned += 1;
      if (res.skipped) log.warn(`Skipped ${relative(REPO_ROOT, file)} (${res.skipped})`);
      findings.push(...res.findings);
    }
    log.ok(
      `Scanned ${files.length} file(s) of the ${target.label} build (${relative(REPO_ROOT, target.dir)})`,
    );
  }

  let requiredMissing = false;
  for (const target of missing) {
    const msg = `No ${target.label} build output at ${relative(REPO_ROOT, target.dir)} - build it first: ${target.build}`;
    if (requireBuild && !target.optional) {
      requiredMissing = true;
      log.fail(msg);
    } else {
      log.warn(msg);
    }
  }

  if (findings.length) {
    console.log('');
    log.fail(`${findings.length} problem(s) found. These must never ship to a client:`);
    for (const f of findings) {
      console.log(`    ${relative(REPO_ROOT, f.file)}  offset ${f.offset} (line ${f.line})`);
      console.log(`      ${f.what}`);
    }
    console.log(`
Fix the cause, not the symptom: only VITE_-prefixed variables reach the web bundle,
the desktop main process reads configuration at runtime, and the renderer receives
server values through the API - never through a build-time define.
`);
    process.exit(1);
  }

  console.log('');
  if (requiredMissing) {
    log.fail(
      'A required build output is missing (--require-build), so nothing was proven about it.',
    );
    process.exit(1);
  }
  if (!scanned) {
    log.warn('Nothing was scanned: no build output exists, so this run proves nothing.');
    return;
  }
  log.ok(`Clean: no secret values and no forbidden patterns in ${scanned} scanned file(s).`);
}

main();
