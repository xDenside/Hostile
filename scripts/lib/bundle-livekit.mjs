import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, TOOLS_DIR } from './env.mjs';

export function bundleLivekit(platform = process.platform, arch = process.arch) {
  const desktop = join(REPO_ROOT, 'apps', 'desktop');
  const manifest = JSON.parse(readFileSync(join(desktop, 'livekit-manifest.json'), 'utf8'));
  const entry = manifest[`${platform}-${arch}`];
  if (!entry) throw new Error(`The manifest names no media server for ${platform}-${arch}.`);
  if (!entry.sha256) {
    throw new Error(
      `The media server for ${platform}-${arch} (${entry.version}) has not been downloaded and checked: its SHA-256 is empty.`,
    );
  }
  const exe = platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
  const source =
    platform === 'darwin'
      ? '/opt/homebrew/opt/livekit/bin/livekit-server'
      : join(
          TOOLS_DIR,
          'livekit',
          entry.version,
          `${platform === 'win32' ? 'windows' : platform}-amd64`,
          exe,
        );
  if (!existsSync(source)) throw new Error(`The media server is not at ${source}.`);
  const found = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (found !== entry.sha256) {
    throw new Error(`${source} does not match the manifest: ${found}, expected ${entry.sha256}.`);
  }
  const outDir = join(desktop, 'build', 'bin');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, exe);
  copyFileSync(source, out);
  chmodSync(out, 0o755);
  return out;
}
