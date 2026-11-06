const { execFileSync } = require('node:child_process');
const path = require('node:path');

const EXECUTABLE_EXTENSION = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' };

module.exports = async function afterPack(context) {
  const { FuseVersion, FuseV1Options, flipFuses } = await import('@electron/fuses');
  const platform = context.electronPlatformName;
  const extension = EXECUTABLE_EXTENSION[platform] ?? '';
  const name =
    platform === 'linux'
      ? context.packager.executableName
      : context.packager.appInfo.productFilename;
  const binary = path.join(context.appOutDir, `${name}${extension}`);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin' || platform === 'mas',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  console.log(`  • electron fuses flipped  file=${binary}`);

  if (platform === 'darwin' && context.packager.platformSpecificBuildOptions.identity === null) {
    const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.adhoc.plist');
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      binary,
    ]);
    console.log(`  • signed ad hoc with the hardened runtime  file=${binary}`);
  }
};
