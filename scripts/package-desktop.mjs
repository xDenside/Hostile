import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/env.mjs';
import { bundleLivekit } from './lib/bundle-livekit.mjs';
import { color, log, resolveBin, runInherit, runSync } from './lib/proc.mjs';

const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web');
const RELEASE_DIR = join(DESKTOP_DIR, 'release');

const PLATFORM_FLAG = { darwin: '--mac', win32: '--win', linux: '--linux' };
const SIGNING_VARIABLES = ['CSC_LINK', 'CSC_NAME', 'CSC_IDENTITY_AUTO_DISCOVERY', 'WIN_CSC_LINK'];

const args = new Set(process.argv.slice(2));
const proof = args.has('--proof');
const PROOF_DIR = join(REPO_ROOT, '.local', 'packaged-proof');
const PROOF_RELAYS = 'ws://127.0.0.1:5392';

function chooseTarget() {
  const requested = ['--mac', '--win', '--linux'].filter((flag) => args.has(flag));
  if (requested.length > 1) {
    log.fail('Pick one target: --mac, --win or --linux.');
    process.exit(1);
  }
  const target = requested[0] ?? PLATFORM_FLAG[process.platform];
  if (!target) {
    log.fail(`No packaging target for platform "${process.platform}".`);
    process.exit(1);
  }
  const native = PLATFORM_FLAG[process.platform];
  if (target !== native && !args.has('--allow-cross')) {
    log.fail(`Refusing to build ${target.slice(2)} artifacts on ${process.platform}.`);
    log.info(
      'Cross-building needs extra tooling that this repository does not install ' +
        '(Windows installers need wine and a mono toolchain on macOS, and the result is rarely usable).',
    );
    log.info(
      'Build on the target OS, or pass --allow-cross if you have set that tooling up yourself.',
    );
    process.exit(1);
  }
  return target;
}

async function step(title, command, commandArgs, options) {
  log.info(title);
  const code = await runInherit(command, commandArgs, options);
  if (code !== 0) {
    log.fail(`${title} failed (exit code ${code}).`);
    process.exit(code);
  }
}

function listArtifacts() {
  let entries;
  try {
    entries = readdirSync(RELEASE_DIR);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(RELEASE_DIR, name))
    .filter((path) => {
      const stats = statSync(path);
      return stats.isFile() && /\.(dmg|zip|exe|AppImage|blockmap)$/.test(path);
    })
    .sort();
}

function certificateVariable(target) {
  const order = target === '--win' ? ['WIN_CSC_LINK', 'CSC_LINK'] : ['CSC_LINK', 'CSC_NAME'];
  return order.find((name) => process.env[name]) ?? null;
}

function macSignature() {
  if (process.platform !== 'darwin') return null;
  let entries;
  try {
    entries = readdirSync(RELEASE_DIR);
  } catch {
    return null;
  }
  for (const name of entries.filter((entry) => entry.startsWith('mac')).sort()) {
    const bundle = join(RELEASE_DIR, name, 'Hostile.app');
    let stats;
    try {
      stats = statSync(bundle);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    const result = runSync('codesign', ['-dv', '--verbose=2', bundle]);
    if (result.code !== 0) continue;
    const report = `${result.stderr}${result.stdout}`;
    if (/^Signature=adhoc$/m.test(report)) return { adHoc: true, team: null };
    const team = /^TeamIdentifier=(?!not set$)(.+)$/m.exec(report);
    if (team) return { adHoc: false, team: team[1] };
  }
  return null;
}

function closingAdvice(target) {
  if (target === '--linux') {
    return `${color(33, 'AppImage build.')} Nobody has run this target yet; treat it as untested.\n`;
  }
  const certificate = certificateVariable(target);
  if (target === '--win') {
    return certificate
      ? `${color(32, `Signing was configured (${certificate}).`)} Check the installer on a Windows machine before handing it out.\n`
      : `${color(33, 'Unsigned build.')} SmartScreen warns ("Windows protected your PC") until the file builds\n` +
          '  reputation; the recipient clicks  More info -> Run anyway.\n';
  }
  const signature = macSignature();
  if (signature?.team) {
    return (
      `${color(32, `Signed by team ${signature.team}.`)} Notarization is a separate step this script does not perform:\n` +
      '  submit the .dmg with notarytool and staple the ticket, or Gatekeeper still warns the recipient.\n'
    );
  }
  const lead = signature?.adHoc
    ? 'Ad-hoc signed only, which Gatekeeper treats as unsigned.'
    : 'Unsigned build.';
  const note =
    certificate && !signature
      ? `  ${certificate} is set, but the signature of the packaged app could not be read.\n`
      : '';
  return (
    `${color(33, lead)} macOS stops it the first time it is opened from a download. Open it once, click\n` +
    '  Done, then allow it under System Settings -> Privacy & Security -> Open Anyway (docs/DESKTOP.md).\n' +
    '  Or, once it is in Applications:  xattr -dr com.apple.quarantine /Applications/Hostile.app\n' +
    note
  );
}

async function main() {
  const target = chooseTarget();

  await step(
    'Type-checking and building the web client…',
    process.execPath,
    [resolveBin('typescript', 'tsc', WEB_DIR), '-p', 'tsconfig.json'],
    { cwd: WEB_DIR },
  );
  await step(
    'Building the web client bundle…',
    process.execPath,
    [resolveBin('vite', 'vite', WEB_DIR), 'build'],
    {
      cwd: WEB_DIR,
      env: { ...process.env, HOSTILE_TEST_RELAYS: proof ? PROOF_RELAYS : '' },
    },
  );
  await step(
    'Bundling the desktop main process and copying the renderer…',
    process.execPath,
    [join(DESKTOP_DIR, 'scripts', 'build.mjs'), ...(proof ? ['--proof'] : [])],
    { cwd: DESKTOP_DIR },
  );

  const userConfiguredSigning = SIGNING_VARIABLES.some((name) => process.env[name]);
  if (!userConfiguredSigning)
    log.info('Signing is off (no CSC_* variables set); this is an unsigned local build.');

  log.info(
    `Media server copied to ${bundleLivekit(target === '--win' ? 'win32' : target === '--linux' ? 'linux' : 'darwin', target === '--mac' ? 'arm64' : 'x64')}`,
  );
  await step(
    `Packaging with electron-builder (${target.slice(2)})…`,
    process.execPath,
    [
      resolveBin('electron-builder', 'electron-builder', DESKTOP_DIR),
      target,
      '--publish',
      'never',
      ...(proof ? ['--dir', `-c.directories.output=${PROOF_DIR}`] : []),
    ],
    {
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        ...(userConfiguredSigning ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }),
      },
    },
  );

  if (proof) {
    console.log(`\n${color(33, 'Proof build, for the packaged-app proofs only:')} ${PROOF_DIR}\n`);
    return;
  }
  const artifacts = listArtifacts();
  if (artifacts.length === 0) {
    log.warn(`electron-builder reported success but no artifact was found in ${RELEASE_DIR}.`);
    process.exit(1);
  }
  console.log(`\n${color(32, 'Artifacts:')}`);
  for (const path of artifacts) console.log(`  ${path}`);
  console.log(`\n${closingAdvice(target)}`);
}

main().catch((err) => {
  log.fail(err?.stack ?? String(err));
  process.exit(1);
});
