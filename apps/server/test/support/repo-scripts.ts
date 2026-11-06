export interface LivekitBinary {
  path: string;
  source: string;
  version: string | null;
  missing?: boolean;
}

interface EnvLib {
  REPO_ROOT: string;
  LOCAL_DIR: string;
  loadRepoEnv(): Record<string, string>;
  randomSecret(bytes?: number): string;
}

interface LivekitLib {
  findLivekitBinary(env: Record<string, string>): LivekitBinary | null;
  renderDevLivekitConfig(env: Record<string, string>, opts?: { apiPort?: number }): string;
  LIVEKIT_VERSION: string;
}

interface NetLib {
  waitForHttp(
    url: string,
    timeoutMs?: number,
    accept?: (res: Response) => boolean,
  ): Promise<boolean>;
}

const libUrl = (file: string) => new URL(`../../../../scripts/lib/${file}`, import.meta.url).href;

const envLib = (await import(libUrl('env.mjs'))) as EnvLib;
const livekitLib = (await import(libUrl('livekit.mjs'))) as LivekitLib;
const netLib = (await import(libUrl('net.mjs'))) as NetLib;

export const { REPO_ROOT, LOCAL_DIR, loadRepoEnv, randomSecret } = envLib;
export const { findLivekitBinary, renderDevLivekitConfig, LIVEKIT_VERSION } = livekitLib;
export const { waitForHttp } = netLib;
