// build/afterPack.js
const fs = require('node:fs/promises');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  const resourcesDir =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'bin')
      : path.join(appOutDir, 'resources', 'bin');

  const binaries = ['yt-dlp', 'ffmpeg'];

  for (const binName of binaries) {
    const binPath = path.join(resourcesDir, binName);
    try {
      await fs.chmod(binPath, 0o755);
      console.log(`[afterPack] Set 0755 executable permissions on: ${binPath}`);
    } catch (err) {
      console.warn(`[afterPack] Warning: Could not chmod ${binPath}: ${err.message}`);
    }
  }
};
